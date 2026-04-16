import os
import torch
import numpy as np
from pydub import AudioSegment
import io

class AudioAnalyzer:
    def __init__(self):
        # Load Silero VAD model
        # We use torch.hub because it's the safest way to get the latest pre-trained model
        self.model, self.utils = torch.hub.load(repo_or_dir='snakers4/silero-vad',
                                              model='silero_vad',
                                              force_reload=False,
                                              onnx=False,
                                              trust_repo=True) # <-- This is the new line!
        (self.get_speech_timestamps, _, self.read_audio, _, _) = self.utils
        self.sampling_rate = 16000 # Silero VAD expects 16kHz

    def process_audio_blob(self, audio_base64):
        """
        Takes a base64 encoded audio blob (e.g. WebM/Opus from browser),
        converts it to 16kHz PCM, and returns speaking vs silence stats.
        """
        try:
            import base64
            header, encoded = audio_base64.split(",", 1) if "," in audio_base64 else (None, audio_base64)
            audio_data = base64.b64decode(encoded)
            
            # 1. Convert to PCM 16kHz Mono using pydub
            audio_segment = AudioSegment.from_file(io.BytesIO(audio_data))
            audio_segment = audio_segment.set_frame_rate(self.sampling_rate).set_channels(1)
            
            # 2. Convert to float32 tensor as expected by Silero
            samples = np.array(audio_segment.get_array_of_samples()).astype(np.float32) / 32768.0
            audio_tensor = torch.from_numpy(samples)
            
            # 3. Get speech timestamps
            speech_timestamps = self.get_speech_timestamps(audio_tensor, self.model, sampling_rate=self.sampling_rate)
            
            # 4. Calculate stats
            total_duration_ms = len(audio_segment)
            total_speech_ms = 0
            
            for ts in speech_timestamps:
                # Timestamps are in samples, convert to ms
                start_ms = (ts['start'] / self.sampling_rate) * 1000
                end_ms = (ts['end'] / self.sampling_rate) * 1000
                total_speech_ms += (end_ms - start_ms)
            
            total_silence_ms = total_duration_ms - total_speech_ms
            
            # Calculate trailing silence (silence at the end of the blob)
            trailing_silence_ms = total_duration_ms
            if len(speech_timestamps) > 0:
                last_end_ms = (speech_timestamps[-1]['end'] / self.sampling_rate) * 1000
                trailing_silence_ms = total_duration_ms - last_end_ms

            return {
                "speech_ms": total_speech_ms,
                "silence_ms": total_silence_ms,
                "trailing_silence_ms": max(0, trailing_silence_ms),
                "duration_ms": total_duration_ms
            }
        except Exception as e:
            print(f"Audio Analysis Error: {e}")
            return None
