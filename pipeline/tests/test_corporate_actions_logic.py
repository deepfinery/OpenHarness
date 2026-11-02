import unittest

from pipeline.layer2 import corporate_actions_logic as ca


class TestCorpActions(unittest.TestCase):
    def test_split_ratio(self):
        self.assertEqual(ca.normalize_split_ratio(4, 1), 4.0)  # 4-for-1
        self.assertEqual(ca.normalize_split_ratio(1, 10), 0.1)  # 1-for-10 reverse
        self.assertIsNone(ca.normalize_split_ratio(1, 0))

    def test_special_dividend(self):
        self.assertTrue(ca.is_special_dividend(5.0, 0.25))  # 20x trailing regular
        self.assertFalse(ca.is_special_dividend(0.26, 0.25))
        self.assertTrue(ca.is_special_dividend(0.1, None, flagged=True))
        self.assertFalse(ca.is_special_dividend(1.0, None))


if __name__ == "__main__":
    unittest.main()
