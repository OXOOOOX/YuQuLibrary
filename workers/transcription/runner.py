"""Local, bounded Qwen3-ASR transcription and genuine forced-alignment timestamps."""
import argparse
import hashlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--audio', required=True)
    parser.add_argument('--model-path', required=True)
    parser.add_argument('--aligner-path', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--language', default=None, help='Omit to auto-detect; e.g. Chinese or English.')
    parser.add_argument('--manifest', help='Optional pinned model-manifest.json from the verified download.')
    parser.add_argument('--device', choices=['cuda', 'cpu'], default='cuda')
    parser.add_argument('--timeout-seconds', type=int, default=300)
    parser.add_argument('--worker', action='store_true', help=argparse.SUPPRESS)
    return parser.parse_args()


def validate_output(args):
    target = Path(args.output).resolve()
    protected = [Path(args.audio).resolve(), Path(__file__).resolve()]
    if args.manifest:
        protected.append(Path(args.manifest).resolve())
    for source in protected:
        if target == source or (target.exists() and source.exists() and target.samefile(source)):
            raise ValueError('Output must not overwrite the audio, runner or model manifest.')
    for directory in (args.model_path, args.aligner_path):
        if target.is_relative_to(Path(directory).resolve()):
            raise ValueError('Output must be outside both model directories.')


def write_json(path, value):
    target = Path(path).resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=target.parent,
                prefix=f'.{target.name}.', suffix='.tmp', delete=False) as stream:
            temporary = Path(stream.name)
            json.dump(value, stream, ensure_ascii=False, indent=2)
        os.replace(temporary, target)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def model_identity(manifest, key, default_id):
    info = manifest.get(key, {})
    files = sorted((item['Path'], item['Sha256']) for item in info.get('files', []))
    digest = hashlib.sha256(json.dumps(files, separators=(',', ':')).encode()).hexdigest() if files else None
    return {'id': info.get('repo', default_id), 'revision': 'sha256:' + digest if digest else 'unrecorded',
            'provider': info.get('downloadProvider', 'local files'),
            'fileRevisions': sorted({item['Revision'] for item in info.get('files', [])}),
            'license': info.get('license', 'See model distribution')}


def transcribe(args):
    # Both models are local-only. Neither audio nor credentials are sent to an API.
    os.environ['HF_HUB_OFFLINE'] = '1'
    os.environ['HF_HUB_DISABLE_IMPLICIT_TOKEN'] = '1'
    os.environ['TOKENIZERS_PARALLELISM'] = 'false'
    import numpy as np
    import soundfile as sf
    import torch
    from scipy.signal import resample_poly
    from transformers import AutoProcessor, AutoModelForMultimodalLM, AutoModelForTokenClassification

    audio_path = Path(args.audio).resolve(strict=True)
    if audio_path.stat().st_size > 20_000_000:
        raise ValueError('Validation audio must be at most 20 MB.')
    info = sf.info(audio_path)
    duration = info.frames / info.samplerate
    if not (0 < duration <= 60) or not (8000 <= info.samplerate <= 192000) or not (1 <= info.channels <= 8):
        raise ValueError('Validation expects 0–60 seconds of supported audio with a valid sample rate/channel count.')
    wave, sample_rate = sf.read(audio_path, dtype='float32', always_2d=True)
    wave = wave.mean(axis=1)
    if not np.isfinite(wave).all():
        raise ValueError('Audio contains non-finite samples.')
    if sample_rate != 16000:
        divisor = math.gcd(sample_rate, 16000)
        wave = resample_poly(wave, 16000 // divisor, sample_rate // divisor).astype(np.float32)
    device = args.device
    if device == 'cuda' and not torch.cuda.is_available():
        raise RuntimeError('CUDA is unavailable; choose --device cpu explicitly for CPU verification.')
    dtype = torch.bfloat16 if device == 'cuda' else torch.float32
    torch.set_num_threads(4)
    if device == 'cuda':
        torch.cuda.reset_peak_memory_stats()
    started = time.perf_counter()
    local = {'local_files_only': True, 'trust_remote_code': False}
    asr_processor = AutoProcessor.from_pretrained(args.model_path, **local)
    asr = AutoModelForMultimodalLM.from_pretrained(args.model_path, dtype=dtype,
        attn_implementation='sdpa', **local).to(device).eval()
    aligner_processor = AutoProcessor.from_pretrained(args.aligner_path, **local)
    aligner = AutoModelForTokenClassification.from_pretrained(args.aligner_path, dtype=dtype,
        attn_implementation='sdpa', **local).to(device).eval()
    if device == 'cuda': torch.cuda.synchronize()
    load_seconds = time.perf_counter() - started
    inputs = asr_processor.apply_transcription_request(audio=wave, language=args.language,
        processor_kwargs={'audio_kwargs': {'sampling_rate': 16000}}).to(device, dtype)
    recognition_started = time.perf_counter()
    with torch.inference_mode():
        generated = asr.generate(**inputs, max_new_tokens=1024, do_sample=False)
    if device == 'cuda': torch.cuda.synchronize()
    recognition_seconds = time.perf_counter() - recognition_started
    generated = generated[:, inputs['input_ids'].shape[1]:]
    if generated.shape[1] >= 1024:
        raise RuntimeError('Transcription reached the output cap; it is not accepted as complete.')
    parsed = asr_processor.decode(generated, return_format='parsed')[0]
    text = parsed['transcription'].strip()
    language = parsed.get('language') or args.language
    if not text or not language:
        raise RuntimeError('Model returned no usable transcript/language.')
    alignment_started = time.perf_counter()
    aligned_inputs, word_lists = aligner_processor.prepare_forced_aligner_inputs(
        audio=wave, transcript=text, language=language,
        processor_kwargs={'audio_kwargs': {'sampling_rate': 16000}})
    aligned_inputs = aligned_inputs.to(device, dtype)
    with torch.inference_mode():
        aligned = aligner(**aligned_inputs)
    words = aligner_processor.decode_forced_alignment(logits=aligned.logits,
        input_ids=aligned_inputs['input_ids'], word_lists=word_lists,
        timestamp_token_id=aligner.config.timestamp_token_id)[0]
    if device == 'cuda': torch.cuda.synchronize()
    alignment_seconds = time.perf_counter() - alignment_started
    segments = [{'startMs': round(item['start_time'] * 1000), 'endMs': round(item['end_time'] * 1000),
        'text': item['text']} for item in words]
    duration_ms = round(duration * 1000)
    previous = 0
    for segment in segments:
        if not (previous <= segment['startMs'] <= segment['endMs'] <= duration_ms + 100):
            raise RuntimeError(f'Forced alignment boundary invalid: previous={previous}, '
                f'start={segment["startMs"]}, end={segment["endMs"]}, duration={duration_ms} ms.')
        # The aligner quantizes boundaries. Trim only the <=100 ms tail overshoot;
        # keep raw words above, and never invent intervals by dividing the text.
        segment['startMs'] = min(segment['startMs'], duration_ms)
        segment['endMs'] = min(segment['endMs'], duration_ms)
        previous = segment['endMs']
    if not segments:
        raise RuntimeError('Forced alignment returned no timestamps.')
    manifest = json.loads(Path(args.manifest).read_text('utf-8')) if args.manifest else {}
    with audio_path.open('rb') as audio_stream:
        audio_sha256 = hashlib.file_digest(audio_stream, 'sha256').hexdigest()
    return {'ok': True, 'model': model_identity(manifest, 'asr', 'Qwen/Qwen3-ASR-0.6B-hf'),
        'aligner': model_identity(manifest, 'aligner', 'Qwen/Qwen3-ForcedAligner-0.6B-hf'),
        'durationMs': duration_ms, 'sampleRate': info.samplerate, 'language': language,
        'text': text, 'segments': segments, 'words': words,
        'audioSha256': audio_sha256,
        'device': torch.cuda.get_device_name() if device == 'cuda' else 'CPU',
        'dtype': str(dtype), 'batchSize': 1, 'remoteCode': False, 'inferenceNetwork': 'offline',
        'elapsed': {'loadSeconds': round(load_seconds, 3), 'recognitionSeconds': round(recognition_seconds, 3),
            'alignmentSeconds': round(alignment_seconds, 3), 'totalSeconds': round(time.perf_counter() - started, 3)},
        'peakAllocatedGpuBytes': torch.cuda.max_memory_allocated() if device == 'cuda' else None,
        'peakReservedGpuBytes': torch.cuda.max_memory_reserved() if device == 'cuda' else None,
        'versions': {name: importlib.metadata.version(name) for name in
            ('torch', 'transformers', 'accelerate', 'numpy', 'scipy', 'soundfile', 'librosa')},
        'limits': {'maxAudioSeconds': 60, 'maxBytes': 20_000_000, 'humanQualityReviewed': False,
            'timestampUnit': 'word_or_CJK_character', 'speakerDiarization': False}}


def main():
    args = arguments()
    if not 1 <= args.timeout_seconds <= 300:
        raise SystemExit('Timeout must be 1–300 seconds for this bounded validation runner.')
    try:
        validate_output(args)
    except (OSError, ValueError) as error:
        print(f'Invalid output: {error}', file=sys.stderr)
        return 1
    if not args.worker:
        try:
            completed = subprocess.run([sys.executable, str(Path(__file__).resolve()), *sys.argv[1:], '--worker'],
                timeout=args.timeout_seconds, check=False)
            return completed.returncode
        except subprocess.TimeoutExpired:
            write_json(args.output, {'ok': False, 'error': 'Inference exceeded the configured time limit.'})
            return 1
    try:
        result = transcribe(args)
        write_json(args.output, result)
        print(json.dumps({'ok': True, 'output': str(Path(args.output).resolve()),
            'durationMs': result['durationMs'], 'segments': len(result['segments']), 'elapsed': result['elapsed']}, ensure_ascii=False))
        return 0
    except Exception as error:
        write_json(args.output, {'ok': False, 'errorType': type(error).__name__, 'error': str(error)})
        print(f'{type(error).__name__}: {error}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
