from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import cv2
import uvicorn
import numpy as np
import base64
import time
from face_analyzer import FaceAnalyzer
from audio_analyzer import AudioAnalyzer
import gc

app = FastAPI()

# Enable CORS for frontend development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global variables
analyzer = None
audio_analyzer = None

class FrameData(BaseModel):
    image: str # Base64 encoded image string
    session_id: str = "default" # Unique ID per user tab

class AudioData(BaseModel):
    audio: str # Base64 encoded audio blob
    session_id: str = "default"

class SessionClearRequest(BaseModel):
    session_id: str

@app.on_event("startup")
async def startup_event():
    global analyzer, audio_analyzer
    # Initialize Analyzers
    analyzer = FaceAnalyzer()
    audio_analyzer = AudioAnalyzer()
    print("System Started - Waiting for frames and audio...")

@app.on_event("shutdown")
async def shutdown_event():
    global analyzer
    if analyzer:
        analyzer.stop()
    print("System Shutdown")

@app.post("/end_session")
async def end_session(data: SessionClearRequest):
    global analyzer
    if analyzer:
        with analyzer.lock:
            if data.session_id in analyzer.sessions:
                del analyzer.sessions[data.session_id]
                gc.collect() # Force garbage collection to free RAM
                print(f"Session {data.session_id} deleted from RAM and GC triggered.")
                return {"success": True, "message": "Session cleared"}
    return {"success": False, "message": "Session not found"}

@app.post("/analyze")
async def analyze_frame(data: FrameData):
    global analyzer
    if analyzer is None:
        raise HTTPException(status_code=500, detail="Analyzer not initialized")

    try:
        # 1. Decode Base64 string to OpenCV Image
        header, encoded = data.image.split(",", 1) if "," in data.image else (None, data.image)
        nparr = np.frombuffer(base64.b64decode(encoded), np.uint8)
        frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

        if frame is None:
            print("Decoding Error: frame is None")
            raise ValueError("Invalid image data")

        print(f"Frame Received: {frame.shape} | Session: {data.session_id}")

        # 2. Analyze with session isolation
        results = analyzer.analyze_frame_sync(frame, session_id=data.session_id)
        
        if results and len(results) > 0:
            face = results[0]
            
            # Unified Confidence Score (0-100)
            # 50% Gaze, 50% Stability
            g_score = face.get('gaze_score', 0)
            s_score = face.get('stability_score', 0)
            confidence = (g_score * 50) + (s_score * 50)
            
            return {
                "detected": True,
                "dominant_emotion": face.get('dominant_emotion'),
                "emotions": face.get('emotions'),
                "gaze_score": round(g_score, 2),
                "stability_score": round(s_score, 2),
                "confidence_score": round(confidence, 1)
            }
        
        return {"detected": False}

    except Exception as e:
        print(f"Error processing frame: {e}")
        return {"detected": False, "error": str(e)}

@app.post("/analyze_audio")
async def analyze_audio(data: AudioData):
    global analyzer, audio_analyzer
    if analyzer is None or audio_analyzer is None:
        raise HTTPException(status_code=500, detail="Analyzers not initialized")

    try:
        # 1. Process audio blob
        stats = audio_analyzer.process_audio_blob(data.audio)
        
        if stats:
            # 2. Update session state
            with analyzer.lock:
                # Ensure session and critical keys exist (robust against backend restarts)
                if data.session_id not in analyzer.sessions:
                    analyzer.sessions[data.session_id] = {
                        "emotions": {},
                        "audio_stats": {
                            "speech_ms": 0, 
                            "silence_ms": 0, 
                            "current_silence_ms": 0
                        },
                        "last_head_pos": (0.5, 0.5),
                        "stability_history": [1.0] * 10,
                        "last_seen": time.time()
                    }
                
                session = analyzer.sessions[data.session_id]
                session['last_seen'] = time.time()
                
                if 'audio_stats' not in session:
                    session['audio_stats'] = {
                        "speech_ms": 0, 
                        "silence_ms": 0, 
                        "current_silence_ms": 0
                    }
                
                if 'audio_buffer' not in session:
                    session['audio_buffer'] = np.array([], dtype=np.float32)
                
                # Robustness for face state (if session was created by audio)
                if 'stability_history' not in session:
                    session['stability_history'] = [1.0] * 10
                    session['last_head_pos'] = (0.5, 0.5)
                
                s_stats = session['audio_stats']

                # Logic: If user spoke a significant amount, reset streak to the silence AFTER speech.
                # If blob was mostly silent/noise, continue the existing streak.
                SPEECH_THRESHOLD_MS = 100 # Ignore sounds shorter than 100ms as noise
                
                if stats.get('speech_ms', 0) > SPEECH_THRESHOLD_MS:
                    # Significant speech detected - streak is just the silence at the tail end
                    s_stats['current_silence_ms'] = stats.get('trailing_silence_ms', 0)
                else:
                    # Mostly silent blob - add the entire blob's silence to the streak
                    s_stats['current_silence_ms'] += stats.get('silence_ms', 0)

                s_stats['speech_ms'] = s_stats.get('speech_ms', 0) + stats.get('speech_ms', 0)
                s_stats['silence_ms'] = s_stats.get('silence_ms', 0) + stats.get('silence_ms', 0)
                
                # Determine Vocal Status based on current streak
                streak = s_stats['current_silence_ms']
                status = "fluent"
                if streak > 10000:
                    status = "freeze"
                elif streak > 5000:
                    status = "stalling"
                elif streak > 2000:
                    status = "thinking"

                # Calculate cumulative fluency
                total_time = s_stats.get('speech_ms', 0) + s_stats.get('silence_ms', 0)
                fluency = (s_stats.get('speech_ms', 0) / total_time * 100) if total_time > 0 else 100
                
                # Buffer Management & Transcription
                samples = stats.pop("samples", None)
                transcription = ""
                is_final = False
                
                if samples is not None and len(samples) > 0:
                    session['audio_buffer'] = np.concatenate((session['audio_buffer'], samples))
                    
                    # Determine if we should flush the buffer (finalize the text)
                    is_flush = False
                    if stats.get('trailing_silence_ms', 0) > 1200:
                        is_flush = True
                    elif stats.get('speech_ms', 0) == 0 and len(session['audio_buffer']) > len(samples):
                        # Chunk was totally silent, meaning user paused. Flush previous speech.
                        is_flush = True
                    elif len(session['audio_buffer']) >= 16000 * 15:
                        # Max buffer size reached (15s)
                        is_flush = True

                    # Transcribe current buffer
                    # Only transcribe if the buffer isn't pure silence
                    # (we know there's speech if buffer length > silent chunk length)
                    if len(session['audio_buffer']) > 0:
                        transcription = audio_analyzer.transcribe_buffer(session['audio_buffer'])
                        
                    if is_flush:
                        session['audio_buffer'] = np.array([], dtype=np.float32)
                        is_final = True
                
                return {
                    "success": True,
                    "fluency": round(fluency, 2),
                    "is_speaking": stats.get('speech_ms', 0) > 0,
                    "vocal_status": status,
                    "silence_streak": round(streak / 1000, 1),
                    "transcription": transcription,
                    "is_final": is_final
                }
        
        return {"success": False, "error": "Could not analyze audio"}

    except Exception as e:
        print(f"Error processing audio: {e}")
        return {"success": False, "error": str(e)}

@app.get("/status")
async def get_status():
    return {"status": "online", "model": "DeepFace (MediaPipe backend)"}

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
