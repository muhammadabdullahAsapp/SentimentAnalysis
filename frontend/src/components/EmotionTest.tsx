'use client';

import React, { useState, useEffect, useRef } from 'react';
import { Camera, StopCircle, RefreshCw, BarChart2, Video, Mic, MicOff, Activity, AlignLeft } from 'lucide-react';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

type Emotions = {
    [key: string]: number;
};

type AnalysisData = {
    detected: boolean;
    dominant_emotion?: string;
    emotions?: Emotions;
    gaze_score?: number;
    stability_score?: number;
    confidence_score?: number;
};

type AudioAnalysisData = {
    success: boolean;
    fluency: number;
    is_speaking: boolean;
    vocal_status?: 'fluent' | 'thinking' | 'stalling' | 'freeze';
    silence_streak?: number;
    error?: string;
};

export default function EmotionTest() {
    const [isStreaming, setIsStreaming] = useState(false);
    const [data, setData] = useState<AnalysisData | null>(null);
    const [audioData, setAudioData] = useState<AudioAnalysisData | null>(null);
    const videoRef = useRef<HTMLVideoElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const sessionIdRef = useRef<string>('');
    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const audioChunksRef = useRef<Blob[]>([]);
    const transcriptEndRef = useRef<HTMLDivElement>(null);
    const [mounted, setMounted] = useState(false);
    const [finalTranscript, setFinalTranscript] = useState('');
    const [interimTranscript, setInterimTranscript] = useState('');

    // Initialize individual session ID
    useEffect(() => {
        setMounted(true);
        sessionIdRef.current = Math.random().toString(36).substring(2, 15);
        console.log("Session Initialized:", sessionIdRef.current);
    }, []);

    // Helper to notify backend to clear RAM
    const endSessionBackend = () => {
        if (!sessionIdRef.current) return;
        
        console.log("Ending session on backend:", sessionIdRef.current);
        const data = JSON.stringify({ session_id: sessionIdRef.current });
        
        // Use sendBeacon for more reliable delivery during page close
        if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
            navigator.sendBeacon(`${API_BASE_URL}/end_session`, new Blob([data], { type: 'application/json' }));
        } else {
            fetch(`${API_BASE_URL}/end_session`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: data,
                keepalive: true
            }).catch(err => console.error("End session failed:", err));
        }
    };

    // Tab close / Refresh cleanup
    useEffect(() => {
        const handleBeforeUnload = () => {
            if (isStreaming) {
                endSessionBackend();
            }
        };
        window.addEventListener('beforeunload', handleBeforeUnload);
        return () => window.removeEventListener('beforeunload', handleBeforeUnload);
    }, [isStreaming]);

    // Start local camera and audio
    const startCamera = async () => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ 
                video: true,
                audio: true 
            });
            
            if (videoRef.current) {
                videoRef.current.srcObject = stream;
            }

            // Set up MediaRecorder for Audio
            const audioStream = new MediaStream(stream.getAudioTracks());
            const recorder = new MediaRecorder(audioStream, { mimeType: 'audio/webm' });
            
            recorder.ondataavailable = (e) => {
                if (e.data.size > 0) {
                    audioChunksRef.current.push(e.data);
                }
            };

            recorder.onstop = async () => {
                const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
                audioChunksRef.current = [];
                sendAudioToBackend(blob);
            };

            mediaRecorderRef.current = recorder;
            recorder.start();
            setIsStreaming(true);
            
            // Start transcript
            setFinalTranscript('');
            setInterimTranscript('');
        } catch (error) {
            console.error("Failed to access media:", error);
            alert("Could not access camera/mic. Please ensure permissions are granted.");
        }
    };

    const sendAudioToBackend = async (blob: Blob) => {
        const reader = new FileReader();
        reader.readAsDataURL(blob);
        reader.onloadend = async () => {
            const base64Audio = reader.result as string;
            try {
                const response = await fetch(`${API_BASE_URL}/analyze_audio`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        audio: base64Audio,
                        session_id: sessionIdRef.current 
                    })
                });
                const result = await response.json();
                setAudioData(result);
                
                if (result.success) {
                    if (result.is_final) {
                        if (result.transcription) {
                            setFinalTranscript(prev => prev + (prev ? ' ' : '') + result.transcription);
                        }
                        setInterimTranscript('');
                    } else {
                        setInterimTranscript(result.transcription || '');
                    }
                }
            } catch (error) {
                console.error("Audio analysis failed:", error);
            }
        };
    };

    // Stop camera and release tracks
    const stopCamera = () => {
        if (videoRef.current && videoRef.current.srcObject) {
            const stream = videoRef.current.srcObject as MediaStream;
            stream.getTracks().forEach(track => track.stop());
            videoRef.current.srcObject = null;
        }
        if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
            mediaRecorderRef.current.stop();
        }

        // Notify backend and ROTATE session ID for next time
        endSessionBackend();
        const oldSession = sessionIdRef.current;
        sessionIdRef.current = Math.random().toString(36).substring(2, 15);
        console.log(`Session Reset: ${oldSession} -> ${sessionIdRef.current}`);

        setIsStreaming(false);
        setData(null);
        setAudioData(null);
    };

    // Audio capture loop (send every 3 seconds)
    useEffect(() => {
        let interval: NodeJS.Timeout;
        if (isStreaming && mediaRecorderRef.current) {
            interval = setInterval(() => {
                if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
                    mediaRecorderRef.current.stop(); // This triggers onstop and sends the blob
                    mediaRecorderRef.current.start(); // Start new chunk
                }
            }, 3000);
        }
        return () => clearInterval(interval);
    }, [isStreaming]);

    // Capture and analyze loop (Video)
    useEffect(() => {
        let timeoutId: NodeJS.Timeout;
        
        const captureFrame = async () => {
            if (!isStreaming || !videoRef.current || !canvasRef.current) return;

            const video = videoRef.current;
            const canvas = canvasRef.current;
            const context = canvas.getContext('2d');

            if (context && video.videoWidth > 0) {
                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;
                context.drawImage(video, 0, 0, canvas.width, canvas.height);
                const imageData = canvas.toDataURL('image/jpeg', 0.6);

                try {
                    const response = await fetch(`${API_BASE_URL}/analyze`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ 
                            image: imageData,
                            session_id: sessionIdRef.current 
                        })
                    });
                    const result = await response.json();
                    
                    if (isStreaming) {
                        setData(result);
                        timeoutId = setTimeout(captureFrame, 200);
                    }
                } catch (error) {
                    console.error("Analysis request failed:", error);
                    if (isStreaming) {
                        timeoutId = setTimeout(captureFrame, 1000);
                    }
                }
            } else {
                timeoutId = setTimeout(captureFrame, 500);
            }
        };

        if (isStreaming) {
            captureFrame();
        }
        
        return () => {
            if (timeoutId) clearTimeout(timeoutId);
        };
    }, [isStreaming, sessionIdRef]);

    // Auto-scroll transcript
    useEffect(() => {
        if (transcriptEndRef.current) {
            transcriptEndRef.current.scrollIntoView({ behavior: 'smooth' });
        }
    }, [finalTranscript, interimTranscript]);

    const emotionList = ['happy', 'sad', 'angry', 'neutral', 'surprise', 'fear', 'disgust'];

    const getBarColor = (emotion: string) => {
        switch (emotion) {
            case 'happy': return 'bg-green-500';
            case 'sad': return 'bg-blue-500';
            case 'angry': return 'bg-red-500';
            case 'neutral': return 'bg-gray-400';
            case 'surprise': return 'bg-yellow-400';
            case 'fear': return 'bg-purple-500';
            case 'disgust': return 'bg-orange-500';
            default: return 'bg-blue-300';
        }
    };

    if (!mounted) return null;

    return (
        <div className="flex flex-col items-center justify-center min-h-screen bg-black text-white p-4">
            <div className="flex flex-col lg:flex-row gap-4 w-full h-[92vh] max-w-[98vw] items-stretch">
                
                {/* Left Column: Video Feed (80% Width) */}
                <div className="lg:w-[80%] w-full flex flex-col h-full">
                    <div className="relative flex-1 bg-gray-950 rounded-[2rem] border border-white/5 shadow-2xl overflow-hidden flex items-center justify-center group">
                        <canvas ref={canvasRef} className="hidden" />
                        <video
                            ref={videoRef}
                            autoPlay
                            playsInline
                            muted
                            className={`w-full h-full object-cover shadow-inner ${isStreaming ? 'block' : 'hidden'}`}
                        />

                        {!isStreaming && (
                            <div className="text-center p-10 opacity-20">
                                <Video size={100} className="mx-auto mb-6 text-gray-500" />
                                <p className="text-3xl font-black text-gray-600 tracking-tighter">ENGINE OFFLINE</p>
                                <p className="text-sm text-gray-700 mt-2 font-bold uppercase tracking-widest">Awaiting initialization...</p>
                            </div>
                        )}
                        
                        {/* Status Badge */}
                        <div className="absolute top-6 left-6 flex items-center gap-2 bg-black/40 backdrop-blur-2xl px-4 py-2 rounded-2xl border border-white/5">
                            <div className={`w-2 h-2 rounded-full ${isStreaming ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`} />
                            <span className="text-[9px] font-black tracking-widest uppercase text-white/70">
                                {isStreaming ? "Live Feed" : "Standby"}
                            </span>
                        </div>

                        {/* Top-Right Confidence Meter (Sleek) */}
                        {isStreaming && data?.detected && (
                            <div className="absolute top-6 right-6 bg-black/60 backdrop-blur-2xl p-4 rounded-[2rem] border border-white/10 flex flex-col items-center gap-3 w-48 shadow-2xl">
                                <span className="text-[9px] font-black text-white/40 uppercase tracking-[0.2em]">Confidence</span>
                                
                                <div className="relative w-full h-2 bg-white/5 rounded-full overflow-hidden">
                                    <div 
                                        className={`absolute inset-0 transition-all duration-700 rounded-full ${
                                            (data.confidence_score || 0) > 70 ? 'bg-green-400' :
                                            (data.confidence_score || 0) > 40 ? 'bg-yellow-400' : 'bg-red-500'
                                        }`}
                                        style={{ width: `${data.confidence_score || 0}%` }}
                                    />
                                    {/* Glass reflection */}
                                    <div className="absolute top-0 left-0 w-full h-1/2 bg-white/10 skew-x-[-20deg]" />
                                </div>

                                <div className="flex justify-between w-full px-1">
                                    <div className="flex flex-col items-center gap-1">
                                        <div className={`w-1.5 h-1.5 rounded-full ${(data.gaze_score || 0) > 0.6 ? 'bg-green-400 animate-pulse shadow-[0_0_8px_rgba(74,222,128,0.5)]' : 'bg-white/10'}`} />
                                        <span className="text-[7px] font-bold text-white/30 uppercase">Gaze</span>
                                    </div>
                                    <div className="flex flex-col items-center gap-1">
                                        <div className={`w-1.5 h-1.5 rounded-full ${(data.stability_score || 0) > 0.7 ? 'bg-blue-400 shadow-[0_0_8px_rgba(96,165,250,0.5)]' : 'bg-white/10'}`} />
                                        <span className="text-[7px] font-bold text-white/30 uppercase">Steady</span>
                                    </div>
                                    <span className="text-xl font-black text-white ml-2">
                                        {data.confidence_score?.toFixed(0)}%
                                    </span>
                                </div>
                            </div>
                        )}

                        {/* Bottom-Left Multi-Modal Status */}
                        {isStreaming && (
                            <div className="absolute bottom-6 left-6 flex items-center gap-4 bg-black/40 backdrop-blur-2xl px-5 py-3 rounded-2xl border border-white/5">
                                <Activity className={`text-blue-500 transition-all ${audioData?.is_speaking ? 'animate-pulse' : 'opacity-20'}`} size={16} />
                                <div className="h-4 w-[1px] bg-white/10" />
                                <div className="flex items-center gap-2">
                                    {audioData?.is_speaking ? <Mic size={16} className="text-green-500" /> : <MicOff size={16} className="text-gray-600" />}
                                    <span className={`text-[9px] font-black uppercase tracking-widest ${audioData?.is_speaking ? 'text-green-500' : 'text-gray-600'}`}>
                                        {audioData?.is_speaking ? 'Voice' : 'Silent'}
                                    </span>
                                </div>
                            </div>
                        )}
                    </div>

                    {/* Bottom Controls */}
                    <div className="flex justify-center mt-4">
                        {!isStreaming ? (
                            <button
                                onClick={startCamera}
                                className="px-12 py-5 bg-white text-black hover:bg-gray-200 rounded-full font-black text-sm uppercase tracking-widest transition-all shadow-xl active:scale-95"
                            >
                                Start Analysis
                            </button>
                        ) : (
                            <button
                                onClick={stopCamera}
                                className="px-12 py-5 bg-red-600 text-white hover:bg-red-700 rounded-full font-black text-sm uppercase tracking-widest transition-all shadow-xl active:scale-95"
                            >
                                End Session
                            </button>
                        )}
                    </div>
                </div>

                {/* Right Column: Features Stack (20% Width) */}
                <div className="lg:w-[20%] w-full flex flex-col gap-4 overflow-y-auto pr-2">
                    
                    {/* Row 1: Facial Sentiment */}
                    <div className="bg-gray-900/50 backdrop-blur-xl border border-white/5 rounded-3xl p-5 shadow-xl">
                        <div className="flex items-center gap-2 mb-4 opacity-60">
                            <BarChart2 size={16} className="text-blue-400" />
                            <h2 className="text-[10px] font-black uppercase tracking-[0.25em]">Sentiment</h2>
                        </div>

                        {!isStreaming || !data ? (
                            <div className="h-32 flex items-center justify-center text-gray-700">
                                 <p className="text-[9px] uppercase tracking-widest font-black animate-pulse">Waiting...</p>
                            </div>
                        ) : (
                            <div className="space-y-4">
                                <div className="text-center py-2 bg-white/5 rounded-2xl">
                                    <p className="text-[8px] text-blue-400 uppercase tracking-widest mb-1 font-bold">Detected</p>
                                    <div className="text-2xl font-black text-white tracking-tight">
                                        {(data && data.dominant_emotion) ? data.dominant_emotion.toUpperCase() : "..." }
                                    </div>
                                </div>
                                <div className="space-y-3">
                                    {data.emotions && emotionList.slice(0, 5).map((emo) => {
                                        const score = data.emotions ? data.emotions[emo] : 0;
                                        const isDominant = emo === data.dominant_emotion;
                                        return (
                                            <div key={emo} className="space-y-1">
                                                <div className="flex justify-between text-[8px] font-black uppercase tracking-widest text-gray-500">
                                                    <span className={isDominant ? 'text-blue-400' : ''}>{emo}</span>
                                                    <span>{score?.toFixed(0)}%</span>
                                                </div>
                                                <div className="h-1 w-full bg-black rounded-full overflow-hidden">
                                                    <div
                                                        className={`h-full rounded-full transition-all duration-500 ${getBarColor(emo)} ${isDominant ? 'opacity-100' : 'opacity-20'}`}
                                                        style={{ width: `${score}%` }}
                                                    />
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        )}
                    </div>

                    {/* Row 2: Vocal Intel */}
                    <div className="bg-gray-900/50 backdrop-blur-xl border border-white/5 rounded-3xl p-5 shadow-xl">
                        <div className="flex items-center gap-2 mb-4 opacity-60">
                            <Mic size={16} className="text-teal-400" />
                            <h2 className="text-[10px] font-black uppercase tracking-[0.25em]">Voice Intel</h2>
                        </div>

                        {!isStreaming || !audioData ? (
                            <div className="h-32 flex items-center justify-center text-gray-700">
                                <Activity size={24} className="animate-pulse opacity-20" />
                            </div>
                        ) : (
                            <div className="space-y-4">
                                <div className="p-4 bg-gradient-to-br from-teal-500/10 to-blue-500/10 rounded-2xl border border-white/5">
                                    <p className="text-[8px] text-teal-400 uppercase tracking-widest mb-1 font-black">Fluency</p>
                                    <div className="text-3xl font-black text-white">
                                        {audioData ? audioData.fluency : 0}%
                                    </div>
                                    <div className="mt-3 h-1 w-full bg-black rounded-full overflow-hidden">
                                        <div 
                                            className="h-full bg-teal-400 rounded-full transition-all duration-1000"
                                            style={{ width: `${(audioData && audioData.fluency) ? audioData.fluency : 0}%` }}
                                        />
                                    </div>
                                </div>
                                
                                {/* Real-time Vocal Status Badge */}
                                <div className={`p-4 rounded-2xl border transition-all duration-500 ${
                                    audioData.vocal_status === 'freeze' ? 'bg-red-500/10 border-red-500/20' :
                                    audioData.vocal_status === 'stalling' ? 'bg-orange-500/10 border-orange-500/20' :
                                    audioData.vocal_status === 'thinking' ? 'bg-yellow-500/10 border-yellow-500/20' :
                                    'bg-green-500/10 border-green-500/20'
                                }`}>
                                    <p className="text-[8px] text-gray-500 uppercase tracking-widest mb-1.5 font-bold text-center">Current Flow</p>
                                    <div className={`text-[10px] font-black text-center uppercase tracking-widest ${
                                        audioData.vocal_status === 'freeze' ? 'text-red-500' :
                                        audioData.vocal_status === 'stalling' ? 'text-orange-400' :
                                        audioData.vocal_status === 'thinking' ? 'text-yellow-400' :
                                        'text-green-500'
                                    }`}>
                                        {audioData.vocal_status === 'freeze' ? 'Critical Freeze Detected' :
                                         audioData.vocal_status === 'stalling' ? 'Unusual Pause / Stalling' :
                                         audioData.vocal_status === 'thinking' ? 'Thinking...' :
                                         'Great Fluency'}
                                    </div>
                                    {audioData.silence_streak && audioData.silence_streak > 1 && (
                                        <p className="text-[8px] text-gray-600 mt-2 text-center font-bold italic">
                                            Silence: {audioData.silence_streak}s
                                        </p>
                                    )}
                                </div>
                            </div>
                        )}
                    </div>

                    {/* Row 3: Live Transcript */}
                    <div className="flex-1 bg-gray-900/50 backdrop-blur-xl border border-white/5 rounded-3xl p-5 shadow-xl flex flex-col min-h-[150px]">
                        <div className="flex items-center gap-2 mb-3 opacity-60">
                            <AlignLeft size={16} className="text-purple-400" />
                            <h2 className="text-[10px] font-black uppercase tracking-[0.25em]">Live Transcript</h2>
                        </div>

                        {!isStreaming ? (
                            <div className="flex-1 flex items-center justify-center text-gray-700">
                                <p className="text-[9px] uppercase tracking-widest font-black animate-pulse">Waiting...</p>
                            </div>
                        ) : (
                            <div className="flex-1 w-full bg-black/40 rounded-2xl p-4 overflow-y-auto border border-white/5">
                                {(finalTranscript || interimTranscript) ? (
                                    <p className="text-xs text-gray-300 leading-relaxed font-medium">
                                        {finalTranscript}
                                        {finalTranscript && interimTranscript && ' '}
                                        {interimTranscript && (
                                            <span className="text-white font-bold opacity-80">{interimTranscript}</span>
                                        )}
                                        <span className="inline-block w-1.5 h-3 ml-1 bg-purple-500 animate-pulse align-middle" />
                                    </p>
                                ) : (
                                    <p className="text-xs text-gray-600 italic">Listening...</p>
                                )}
                                <div ref={transcriptEndRef} />
                            </div>
                        )}
                    </div>

                </div>
            </div>
        </div>
    );
}
