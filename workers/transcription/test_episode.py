import unittest

from episode import EpisodeError, group_words, identity, select_core_words


class EpisodeBoundaryTests(unittest.TestCase):
    def test_half_open_midpoint_assigns_cross_boundary_word_once(self):
        words = [{'start_time': 29.9, 'end_time': 30.2, 'text': 'boundary'}]
        self.assertEqual(select_core_words(words, 0, 0, 30000, 60000), [])
        selected = select_core_words(words, 0, 30000, 60000, 60000)
        self.assertEqual(selected, [{'startMs': 29900, 'endMs': 30200, 'text': 'boundary'}])

    def test_relative_offset_and_exact_boundary(self):
        words = [{'start_time': 4.9, 'end_time': 5.1, 'text': 'word'}]
        self.assertEqual(select_core_words(words, 25000, 30000, 60000, 60000)[0]['startMs'], 29900)

    def test_cut_word_in_unowned_context_does_not_fail_core(self):
        words = [{'start_time': 34.8, 'end_time': 35.12, 'text': 'context'}]
        self.assertEqual(select_core_words(words, 0, 0, 30000, 35000), [])

    def test_tail_quantization_trim_but_larger_overrun_rejected(self):
        short = [{'start_time': 59.8, 'end_time': 60.08, 'text': 'last'}]
        self.assertEqual(select_core_words(short, 0, 30000, 60000, 60000)[0]['endMs'], 60000)
        with self.assertRaises(EpisodeError):
            select_core_words([{'start_time': 59.8, 'end_time': 60.12, 'text': 'last'}],
                0, 30000, 60000, 60000)

    def test_nonfinite_and_reverse_alignment_rejected(self):
        for word in [{'start_time': float('nan'), 'end_time': 1, 'text': 'x'},
                     {'start_time': 2, 'end_time': 1, 'text': 'x'}]:
            with self.assertRaises(EpisodeError):
                select_core_words([word], 0, 0, 30000, 30000)

    def test_true_tail_overrun_cannot_hide_beyond_last_core(self):
        with self.assertRaises(EpisodeError):
            select_core_words([{'start_time': 59.98, 'end_time': 60.3, 'text': 'last'}],
                0, 30000, 60000, 60000)

    def test_decoded_tail_longer_than_media_keeps_crossing_word_with_real_bounds(self):
        word = [{'start_time': 34.8, 'end_time': 35.2, 'text': 'last'}]
        self.assertEqual(select_core_words(word, 3565000, 3570000, 3600000, 3600200, 3600000),
                         [{'startMs': 3599800, 'endMs': 3600000, 'text': 'last'}])
        with self.assertRaises(EpisodeError):
            select_core_words(word, 3565000, 3570000, 3600000, 3600000, 3600000)
        # The midpoint can be beyond the media end but still inside decoded audio.
        self.assertEqual(select_core_words([{'start_time': 59.9, 'end_time': 60.2, 'text': 'last'}],
                                          0, 30000, 60000, 60200, 60000),
                         [{'startMs': 59900, 'endMs': 60000, 'text': 'last'}])

    def test_actual_shorter_tail_limits_storage_to_real_audio(self):
        word = [{'start_time': 59.6, 'end_time': 59.9, 'text': 'last'}]
        self.assertEqual(select_core_words(word, 0, 30000, 60000, 59800, 60000),
                         [{'startMs': 59600, 'endMs': 59800, 'text': 'last'}])
        with self.assertRaises(EpisodeError):
            select_core_words([{'start_time': 59.6, 'end_time': 59.901, 'text': 'last'}],
                              0, 30000, 60000, 59800, 60000)

    def test_words_entirely_beyond_media_have_no_storable_interval(self):
        self.assertEqual(select_core_words([{'start_time': 60.01, 'end_time': 60.2, 'text': 'tail'}],
                                          0, 30000, 60000, 60200, 60000), [])
        with self.assertRaises(EpisodeError):
            select_core_words([{'start_time': 60.01, 'end_time': 60.301, 'text': 'bad'}],
                              0, 30000, 60000, 60200, 60000)

    def test_short_last_core_does_not_duplicate_real_tail(self):
        word = [{'start_time': 59.7, 'end_time': 59.9, 'text': 'last'}]
        self.assertEqual(select_core_words(word, 0, 30000, 60000, 59900, 60050),
                         [{'startMs': 59700, 'endMs': 59900, 'text': 'last'}])
        self.assertEqual(select_core_words(word, 0, 60000, 60050, 59900, 60050), [])

    def test_grouping_uses_real_edges_and_no_cjk_spaces(self):
        words = [{'startMs': 200, 'endMs': 400, 'text': '你'},
                 {'startMs': 400, 'endMs': 700, 'text': '好'},
                 {'startMs': 2000, 'endMs': 2500, 'text': 'hello'},
                 {'startMs': 2500, 'endMs': 3000, 'text': 'world'}]
        self.assertEqual(group_words(words), [
            {'startMs': 200, 'endMs': 700, 'text': '你好'},
            {'startMs': 2000, 'endMs': 3000, 'text': 'hello world'}])

    def test_model_fingerprint_changes_when_aligner_changes(self):
        manifest = {key: {'repo': key, 'files': [{'Path': 'model', 'Sha256': 'a', 'Revision': 'b'}]}
                    for key in ('asr', 'aligner')}
        before = identity(manifest)
        manifest['aligner']['files'][0]['Sha256'] = 'changed'
        self.assertNotEqual(before['revision'], identity(manifest)['revision'])


if __name__ == '__main__':
    unittest.main()
