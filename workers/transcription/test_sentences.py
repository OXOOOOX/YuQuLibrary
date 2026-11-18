import unittest
from sentence_segments import restore_surface, semantic_groups, ends_sentence
from episode import select_core_words, semantic_segments, identity, EpisodeError


class SentenceTests(unittest.TestCase):
    def test_surface_is_exact_even_inside_decimal_and_code_tokens(self):
        text = '用print("Hello"); 版本3.14，访问foo.bar。'
        tokens = ['用', 'printHello', '版', '本', '314', '访', '问', 'foobar']
        words = [{'text': token, 'start_time': i, 'end_time': i + .5} for i, token in enumerate(tokens)]
        self.assertEqual(''.join(w['surface'] for w in restore_surface(words, text)), text)

    def test_zero_duration_words_are_not_silently_deleted(self):
        raw = [{'text': 'due', 'start_time': 1, 'end_time': 1.2},
               {'text': 'to', 'start_time': 1.2, 'end_time': 1.2},
               {'text': 'rain', 'start_time': 1.2, 'end_time': 2}]
        words, groups = semantic_segments(raw, 'due to rain.', 0, 0, 3000, 3000, 3000)
        self.assertEqual(groups, [{'startMs': 1000, 'endMs': 2000, 'text': 'due to rain.'}])
        self.assertEqual(words[1]['startMs'], words[1]['endMs'])
        self.assertEqual(len(select_core_words(raw, 0, 0, 3000, 3000)), 2)

    def test_quotes_and_internal_punctuation_across_tokens(self):
        for text, tokens in [('3.14', ['3', '14']), ('foo.bar', ['foo', 'bar']),
                             ("say 'hello'", ['say', 'hello']), ('don’t', ["don't"])]:
            raw = [{'text': token, 'start_time': i * .1, 'end_time': (i + 1) * .1} for i, token in enumerate(tokens)]
            _, groups = semantic_segments(raw, text, 0, 0, 2000, 2000, 2000)
            self.assertEqual([group['text'] for group in groups], [text])

    def test_cross_core_space_and_decimal_join_metadata(self):
        for text, tokens, expected_space in [('Dr. Smith', ['Dr', 'Smith'], True), ('3.14', ['3', '14'], False)]:
            raw = [{'text': tokens[0], 'start_time': 4.8, 'end_time': 5},
                   {'text': tokens[1], 'start_time': 5, 'end_time': 5.2}]
            _, groups = semantic_segments(raw, text, 25000, 30000, 60000, 60000, 60000)
            self.assertTrue(groups[0]['continuesPrevious'])
            self.assertEqual(groups[0]['joinWithSpace'], expected_space)

    def test_zero_at_boundary_has_one_owner_and_clipped_tail_stays_excluded(self):
        raw = [{'text': 'word', 'start_time': 30, 'end_time': 30}]
        self.assertEqual(select_core_words(raw, 0, 0, 30000, 60000, preserve_text=True), [])
        self.assertEqual(len(select_core_words(raw, 0, 30000, 60000, 60000, preserve_text=True)), 1)
        tail = [{'text': 'outside', 'start_time': 60.01, 'end_time': 60.2}]
        self.assertEqual(select_core_words(tail, 0, 30000, 60000, 60200, 60000, True), [])

    def test_cross_core_program_is_marked_and_long_sentence_not_hard_cut(self):
        text = '要注意程序是自上而下执行的，也就是说先执行第一个print，再向下依次执行，这样也可以保证打印出的诗句顺序不会乱。'
        tokens = list('要注意程序是自上而下执行的也就是说先执行第一个') + ['print'] + list('再向下依次执行这样也可以保证打印出的诗句顺序不会乱')
        raw = [{'text': token, 'start_time': 3.8 + i * .2, 'end_time': 4 + i * .2} for i, token in enumerate(tokens)]
        _, left = semantic_segments(raw, text, 115000, 90000, 120000, 180000, 180000)
        _, right = semantic_segments(raw, text, 115000, 120000, 150000, 180000, 180000)
        self.assertEqual(left[0]['text'] + right[0]['text'], text)
        self.assertTrue(right[0]['continuesPrevious'])
        self.assertEqual(len(right), 1)

    def test_sentence_closers_titles_and_mismatch(self):
        words = [{'text': 'Dr. ', 'startMs': 0, 'endMs': 100},
                 {'text': 'Smith. ', 'startMs': 100, 'endMs': 200},
                 {'text': '你好。”', 'startMs': 200, 'endMs': 300}]
        self.assertEqual([s['text'] for s in semantic_groups(words)], ['Dr. Smith.', '你好。”'])
        self.assertFalse(ends_sentence('3.14'))
        self.assertFalse(ends_sentence('U.S.'))
        with self.assertRaises(EpisodeError):
            semantic_segments([{'text': 'wrong', 'start_time': 0, 'end_time': 1}], 'right.', 0, 0, 2000, 2000, 2000)

    def test_pipeline_identity_distinguishes_semantic_output(self):
        manifest = {k: {'files': [{'Path': 'm', 'Sha256': 'a', 'Revision': 'b'}]} for k in ('asr', 'aligner')}
        self.assertNotEqual(identity(manifest)['revision'], identity(manifest, True)['revision'])


if __name__ == '__main__':
    unittest.main()
