"""Offline episode transcription: 30-second committed cores, genuine word timestamps."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unicodedata

from runner import model_identity
from parent_pipe import ParentPipe, ParentPipeError
from sentence_segments import restore_surface, semantic_groups, ends_sentence

CORE_MS = 30_000
CONTEXT_MS = 5_000
MAX_DURATION_MS = 4 * 3_600_000
MAX_BYTES = 100 * 1024 * 1024
PIPELINE = 'yuqu-qwen3-episode-v2'
SEMANTIC_PIPELINE = 'yuqu-qwen3-episode-v3'


class EpisodeError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def emit(value):
    print(json.dumps(value, ensure_ascii=False, separators=(',', ':')), flush=True)


def identity(manifest, semantic=False):
    asr = model_identity(manifest, 'asr', 'Qwen/Qwen3-ASR-0.6B-hf')
    aligner = model_identity(manifest, 'aligner', 'Qwen/Qwen3-ForcedAligner-0.6B-hf')
    if asr['revision'] == 'unrecorded' or aligner['revision'] == 'unrecorded':
        raise EpisodeError('MODEL_MANIFEST_INVALID')
    pipeline = SEMANTIC_PIPELINE if semantic else PIPELINE
    fingerprint = hashlib.sha256(json.dumps([pipeline, asr['revision'], aligner['revision']],
        separators=(',', ':')).encode()).hexdigest()
    return {'id': asr['id'], 'revision': 'sha256:' + fingerprint,
        'pipeline': pipeline, 'asr': asr, 'aligner': aligner}


def verify_models(manifest, paths):
    for key, directory in paths.items():
        root = Path(directory).resolve(strict=True)
        entry = manifest.get(key, {})
        files = entry.get('files', [])
        if not files:
            raise EpisodeError('MODEL_MANIFEST_INVALID')
        for item in files:
            path = (root / item['Path']).resolve(strict=True)
            if not path.is_relative_to(root) or not path.is_file():
                raise EpisodeError('MODEL_MANIFEST_INVALID')
            with path.open('rb') as stream:
                digest = hashlib.file_digest(stream, 'sha256').hexdigest()
            if digest != item['Sha256']:
                raise EpisodeError('MODEL_CHECKSUM_MISMATCH')


def select_core_words(words, window_start_ms, core_start_ms, core_end_ms, actual_duration_ms,
                      media_duration_ms=None, preserve_text=False):
    """Assign overlap by a real word's midpoint; never estimate timing from text length."""
    media_duration_ms = actual_duration_ms if media_duration_ms is None else media_duration_ms
    final_core = core_end_ms == media_duration_ms
    stored_end_ms = min(actual_duration_ms, media_duration_ms)
    selected = []
    previous = -1
    for word in words:
        raw_start, raw_end = word['start_time'], word['end_time']
        if not isinstance(raw_start, (int, float)) or not isinstance(raw_end, (int, float)):
            raise EpisodeError('ALIGNMENT_INVALID')
        if not math.isfinite(raw_start) or not math.isfinite(raw_end):
            raise EpisodeError('ALIGNMENT_INVALID')
        start = window_start_ms + round(raw_start * 1000)
        end = window_start_ms + round(raw_end * 1000)
        if start < previous or end < start:
            raise EpisodeError('ALIGNMENT_INVALID')
        previous = end
        if final_core and end > actual_duration_ms + 100:
            # At the real episode end there is no following core to own a cut word.
            raise EpisodeError('ALIGNMENT_INVALID')
        midpoint = (start + end) / 2
        if midpoint < core_start_ms or (not final_core and midpoint >= core_end_ms):
            # The contextual window may end mid-word; it does not own that word.
            continue
        if start < 0 or end > actual_duration_ms + 100:
            raise EpisodeError('ALIGNMENT_INVALID')
        # Validate against decoded audio first; storage remains within media bounds.
        unclipped_start, unclipped_end = start, end
        start, end = min(start, stored_end_ms), min(end, stored_end_ms)
        text = word.get('surface', word['text']) if preserve_text else word['text']
        if not isinstance(text, str) or not text.strip() or len(text) > 2000:
            raise EpisodeError('ALIGNMENT_INVALID')
        # A real zero-length alignment is an uncertain point, not a missing word.
        # Keep its text in v3 without inventing a duration. Do not resurrect words
        # wholly beyond the media tail that merely became zero after clipping.
        if end <= start and not (preserve_text and unclipped_start == unclipped_end and unclipped_start <= stored_end_ms):
            continue
        selected.append({'startMs': start, 'endMs': end, 'text': text})
    return selected


def semantic_segments(raw_words, text, window_start_ms, start_ms, end_ms, actual_ms, media_ms):
    try:
        surfaced = restore_surface(raw_words, text)
    except ValueError as error:
        raise EpisodeError('TEXT_ALIGNMENT_MISMATCH') from error
    words = select_core_words(surfaced, window_start_ms, start_ms, end_ms, actual_ms, media_ms, True)
    continues, join_with_space = False, False
    if start_ms > 0 and words:
        first = words[0]
        for index, word in enumerate(surfaced):
            if (window_start_ms + round(word['start_time'] * 1000) == first['startMs'] and
                    word['surface'] == first['text']):
                if index:
                    previous = surfaced[index - 1]
                    gap = round((word['start_time'] - previous['end_time']) * 1000)
                    continues = gap < 800 and not ends_sentence(previous['surface'], word['surface'])
                    join_with_space = previous['surface'][-1:].isspace() or word['surface'][:1].isspace()
                break
    return words, semantic_groups(words, continues, join_with_space)


def join_words(words):
    """Readable CJK/Latin joining; output is based on aligner tokens, without invented punctuation."""
    result = ''
    for word in words:
        text = word['text']
        if result and text:
            left, right = result[-1], text[0]
            cjk_left = unicodedata.east_asian_width(left) in ('W', 'F')
            cjk_right = unicodedata.east_asian_width(right) in ('W', 'F')
            if not cjk_left and not cjk_right:
                result += ' '
        result += text
    return result


def group_words(words):
    groups, current = [], []
    for word in words:
        if current and (word['startMs'] - current[-1]['endMs'] >= 800 or
                        word['endMs'] - current[0]['startMs'] > 8000 or
                        sum(len(item['text']) for item in current) + len(word['text']) > 160):
            groups.append({'startMs': current[0]['startMs'], 'endMs': current[-1]['endMs'],
                'text': join_words(current)})
            current = []
        current.append(word)
    if current:
        groups.append({'startMs': current[0]['startMs'], 'endMs': current[-1]['endMs'],
            'text': join_words(current)})
    return groups


class Recognizer:
    def __init__(self, args):
        began = time.perf_counter()
        import torch
        from transformers import AutoProcessor, AutoModelForMultimodalLM, AutoModelForTokenClassification
        from transformers.utils import logging
        logging.set_verbosity_error()
        logging.disable_progress_bar()
        self.torch = torch
        if not torch.cuda.is_available():
            raise EpisodeError('CUDA_UNAVAILABLE')
        self.device, self.dtype = 'cuda', torch.bfloat16
        torch.set_num_threads(4)
        local = {'local_files_only': True, 'trust_remote_code': False}
        self.asr_processor = AutoProcessor.from_pretrained(args.model_path, **local)
        self.asr = AutoModelForMultimodalLM.from_pretrained(args.model_path, dtype=self.dtype,
            attn_implementation='sdpa', **local).to(self.device).eval()
        self.aligner_processor = AutoProcessor.from_pretrained(args.aligner_path, **local)
        self.aligner = AutoModelForTokenClassification.from_pretrained(args.aligner_path,
            dtype=self.dtype, attn_implementation='sdpa', **local).to(self.device).eval()
        torch.cuda.synchronize()
        torch.cuda.reset_peak_memory_stats()
        self.load_seconds = time.perf_counter() - began
        self.diagnostic = None

    def recognize(self, wave):
        self.torch.cuda.synchronize()
        began = time.perf_counter()
        inputs = self.asr_processor.apply_transcription_request(audio=wave, language=None,
            processor_kwargs={'audio_kwargs': {'sampling_rate': 16000}}).to(self.device, self.dtype)
        with self.torch.inference_mode():
            generated = self.asr.generate(**inputs, max_new_tokens=1024, do_sample=False)
        generated = generated[:, inputs['input_ids'].shape[1]:]
        if generated.shape[1] >= 1024:
            raise EpisodeError('TRANSCRIPT_TRUNCATED')
        parsed = self.asr_processor.decode(generated, return_format='parsed')[0]
        text, language = parsed['transcription'].strip(), parsed.get('language')
        self.torch.cuda.synchronize()
        recognition_seconds = time.perf_counter() - began
        self.diagnostic = {'text': text, 'language': language, 'alignedWords': [],
            'recognitionSeconds': recognition_seconds, 'alignmentSeconds': 0}
        if not text:
            return [], language
        if not language:
            raise EpisodeError('LANGUAGE_UNAVAILABLE')
        began = time.perf_counter()
        aligned_inputs, word_lists = self.aligner_processor.prepare_forced_aligner_inputs(
            audio=wave, transcript=text, language=language,
            processor_kwargs={'audio_kwargs': {'sampling_rate': 16000}})
        aligned_inputs = aligned_inputs.to(self.device, self.dtype)
        with self.torch.inference_mode():
            aligned = self.aligner(**aligned_inputs)
        words = self.aligner_processor.decode_forced_alignment(logits=aligned.logits,
            input_ids=aligned_inputs['input_ids'], word_lists=word_lists,
            timestamp_token_id=self.aligner.config.timestamp_token_id)[0]
        self.torch.cuda.synchronize()
        self.diagnostic.update(alignedWords=words, alignmentSeconds=time.perf_counter() - began,
            loadSeconds=self.load_seconds,
            peakAllocatedGpuBytes=self.torch.cuda.max_memory_allocated(),
            peakReservedGpuBytes=self.torch.cuda.max_memory_reserved())
        return words, language


def decode_audio(args, target, parent):
    command = [str(Path(args.ffmpeg_path).resolve(strict=True)), '-hide_banner', '-loglevel', 'error',
        '-nostdin', '-y', '-threads', '2', '-protocol_whitelist', 'file,pipe',
        '-i', str(Path(args.audio).resolve(strict=True)), '-map', '0:a:0', '-vn', '-sn', '-dn',
        '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav',
        '-t', str(args.duration_ms / 1000 + 1), str(target)]
    try:
        process = parent.run_decoder(command, timeout=300)
    except subprocess.TimeoutExpired as error:
        raise EpisodeError('DECODE_TIMEOUT') from error
    if process.returncode != 0:
        raise EpisodeError('DECODE_FAILED')


def run(args, parent):
    os.environ.update(HF_HUB_OFFLINE='1', HF_HUB_DISABLE_IMPLICIT_TOKEN='1',
        HF_HUB_DISABLE_PROGRESS_BARS='1', TOKENIZERS_PARALLELISM='false')
    if not 0 < args.duration_ms <= MAX_DURATION_MS:
        raise EpisodeError('AUDIO_LIMIT')
    if not 0 <= args.resume_ms <= args.duration_ms or (args.resume_ms != args.duration_ms and args.resume_ms % CORE_MS):
        raise EpisodeError('RESUME_INVALID')
    source = Path(args.audio).resolve(strict=True)
    if not source.is_file() or not 0 < source.stat().st_size <= MAX_BYTES:
        raise EpisodeError('AUDIO_LIMIT')
    manifest = json.loads(Path(args.manifest).read_text('utf-8'))
    semantic = args.pipeline == 'semantic-v3'
    model = identity(manifest, semantic)
    verify_models(manifest, {'asr': args.model_path, 'aligner': args.aligner_path})
    diagnostic_path = Path(args.diagnostics).resolve() if args.diagnostics else None
    if diagnostic_path:
        # Explicit local diagnostics only: never send raw text to the worker API/log.
        with diagnostic_path.open('x', encoding='utf-8'):
            pass
    import numpy as np
    import soundfile as sf
    with tempfile.TemporaryDirectory(prefix='yuqu-asr-episode-', dir=args.work_dir) as directory:
        decoded = Path(directory) / 'decoded.wav'
        decode_audio(args, decoded, parent)
        info = sf.info(decoded)
        actual_duration_ms = round(info.frames * 1000 / info.samplerate)
        if info.samplerate != 16000 or info.channels != 1 or abs(actual_duration_ms - args.duration_ms) > 250:
            raise EpisodeError('AUDIO_DURATION_MISMATCH')
        recognizer = None
        with sf.SoundFile(decoded, 'r') as audio:
            for start_ms in range(args.resume_ms, args.duration_ms, CORE_MS):
                end_ms = min(start_ms + CORE_MS, args.duration_ms)
                window_start_ms = max(0, start_ms - CONTEXT_MS)
                window_end_ms = min(actual_duration_ms, end_ms + CONTEXT_MS)
                first_frame = window_start_ms * 16
                end_frame = min(info.frames, window_end_ms * 16)
                audio.seek(first_frame)
                wave = audio.read(end_frame - first_frame, dtype='float32')
                if not len(wave) or not np.isfinite(wave).all():
                    raise EpisodeError('AUDIO_DECODE_INVALID')
                # Only nearly digital silence is skipped; this is not speech detection.
                silent = bool(np.max(np.abs(wave)) < 0.00001)
                if silent:
                    raw_words, language = [], None
                else:
                    if recognizer is None:
                        recognizer = Recognizer(args)
                    raw_words, language = recognizer.recognize(wave)
                if semantic:
                    words, segments = semantic_segments(raw_words,
                        recognizer.diagnostic['text'] if not silent else '',
                        window_start_ms, start_ms, end_ms, actual_duration_ms, args.duration_ms)
                else:
                    words = select_core_words(raw_words, window_start_ms, start_ms, end_ms,
                        actual_duration_ms, args.duration_ms)
                    segments = group_words(words)
                if diagnostic_path:
                    record = {'index': start_ms // CORE_MS, 'windowStartMs': window_start_ms,
                        'coreStartMs': start_ms, 'coreEndMs': end_ms, 'actualDurationMs': actual_duration_ms,
                        'recognition': recognizer.diagnostic if not silent else None,
                        'selectedWords': words, 'segments': segments, 'model': model}
                    with diagnostic_path.open('a', encoding='utf-8') as stream:
                        stream.write(json.dumps(record, ensure_ascii=False) + '\n')
                emit({'type': 'chunk', 'index': start_ms // CORE_MS, 'startMs': start_ms,
                    'endMs': end_ms, 'actualDurationMs': actual_duration_ms,
                    'segments': segments, 'words': words, 'model': model,
                    'language': language or 'unknown', 'silence': silent})
                # No next chunk is started until the durable database commit is acknowledged.
                parent.expect('continue')
        emit({'type': 'done', 'durationMs': args.duration_ms, 'actualDurationMs': actual_duration_ms,
            'model': model})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for flag in ('audio', 'model-path', 'aligner-path', 'manifest', 'ffmpeg-path'):
        parser.add_argument('--' + flag, required=True)
    parser.add_argument('--duration-ms', required=True, type=int)
    parser.add_argument('--resume-ms', default=0, type=int)
    parser.add_argument('--work-dir', help='Parent-owned temporary directory for supervised cleanup.')
    parser.add_argument('--diagnostics', help='Explicit new local JSONL file; contains recognized text.')
    parser.add_argument('--pipeline', choices=['legacy-v2', 'semantic-v3'], default='legacy-v2')
    args = parser.parse_args()
    try:
        with ParentPipe() as parent:
            # The Node parent durably records our PID before permitting any
            # decoding, model verification, imports, or GPU allocation.
            parent.expect('start')
            run(args, parent)
        return 0
    except (EpisodeError, ParentPipeError) as error:
        print(json.dumps({'code': error.code if isinstance(error, EpisodeError) else 'ACK_REQUIRED'}), file=sys.stderr, flush=True)
        return 1
    except Exception as error:
        # Avoid source paths, model output, credentials, or raw decoder messages in logs.
        code = 'GPU_OUT_OF_MEMORY' if type(error).__name__ == 'OutOfMemoryError' else 'TRANSCRIPTION_FAILED'
        print(json.dumps({'code': code, 'errorType': type(error).__name__}), file=sys.stderr, flush=True)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
