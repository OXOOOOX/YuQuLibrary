"""Punctuation-first grouping of real aligned tokens (no generated text or timing).

Design references: stable-ts regrouping and FunASR's unfinished-sentence handling.
The immutable core fragments carry continuation metadata; the server joins them.
"""
import re
import unicodedata


def lexical(text):
    return ''.join(c for c in unicodedata.normalize('NFKC', text).casefold()
                   if unicodedata.category(c)[0] in ('L', 'N'))


def restore_surface(words, text):
    """Map the same ASR text back exactly, including token-internal punctuation."""
    positions, normalized = [], []
    for index, character in enumerate(text):
        for character in lexical(character):
            positions.append(index)
            normalized.append(character)
    # Quote-only tokens contribute punctuation through source slices, not a
    # separate timed word. Match apostrophe variants without rewriting source.
    words = [word for word in words if lexical(word['text'])]
    tokens = [lexical(word['text']) for word in words]
    if ''.join(tokens) != ''.join(normalized):
        raise ValueError('TEXT_ALIGNMENT_MISMATCH')
    result, offset, previous_end = [], 0, 0
    for index, (word, token) in enumerate(zip(words, tokens)):
        offset += len(token)
        end = positions[offset] if offset < len(positions) else len(text)
        # Opening punctuation belongs to the following token, not the prior sentence.
        if index < len(words) - 1:
            lexical_end = positions[offset - 1] + 1
            between = text[lexical_end:end]
            opening = re.search(r'[“「『（(\[]', between)
            if opening:
                end = lexical_end + opening.start()
        result.append({**word, 'surface': text[previous_end:end]})
        previous_end = end
    return result


def ends_sentence(text, following=''):
    tail = text.rstrip().rstrip('”’"\'」』）)]').rstrip()
    if not tail:
        return False
    if tail[-1] in '。！？!?；;':
        return True
    if not tail.endswith('.'):
        return False
    if (not text[-1:].isspace() and len(tail) > 1 and
            re.match(r'[A-Za-z0-9]', following) and re.match(r'[A-Za-z0-9]', tail[-2])):
        return False
    # Preserve common titles, initials and dotted abbreviations. These are only
    # boundary rules; the source spelling is always retained.
    token = tail.split()[-1]
    if token.casefold() in ('mr.', 'mrs.', 'ms.', 'dr.', 'prof.', 'sr.', 'jr.', 'e.g.', 'i.e.', 'vs.'):
        return False
    return not re.fullmatch(r'(?:[A-Za-z]\.)+', token)


def boundary_between(left, right):
    return ends_sentence(left['text'], right['text']) or right['startMs'] - left['endMs'] >= 800


def semantic_groups(words, continues_previous=False, join_with_space=False):
    """Use sentence punctuation; split long sentences only at a clause or pause."""
    groups, current = [], []
    def flush():
        if current:
            groups.append({'startMs': current[0]['startMs'], 'endMs': current[-1]['endMs'],
                           'text': ''.join(w['text'] for w in current).strip()})
            current.clear()
    for word in words:
        if current:
            text = ''.join(item['text'] for item in current)
            long_clause = (len(text) >= 80 or current[-1]['endMs'] - current[0]['startMs'] >= 15000)
            clause_end = text.rstrip().endswith(('，', ',', '：', ':', '、'))
            if boundary_between(current[-1], word) or (long_clause and clause_end):
                flush()
        current.append(word)
    flush()
    if groups and continues_previous:
        groups[0]['continuesPrevious'] = True
        groups[0]['joinWithSpace'] = join_with_space
    return groups
