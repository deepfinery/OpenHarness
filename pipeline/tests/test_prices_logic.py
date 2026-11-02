import unittest
from datetime import date

from pipeline.layer2 import prices_logic as p


class TestSplitFactors(unittest.TestCase):
    def test_backward_cumulative_4for1(self):
        dates = [date(2020, 8, 28), date(2020, 8, 31)]  # split ex on 8/31, ratio 4
        f = p.split_adjustment_factors(dates, [(date(2020, 8, 31), 4.0)])
        self.assertAlmostEqual(f[date(2020, 8, 28)], 0.25)  # pre-split scaled to new basis
        self.assertAlmostEqual(f[date(2020, 8, 31)], 1.0)


class TestSymbolRows(unittest.TestCase):
    def test_clean_split_zero_return_and_continuous_adj(self):
        bars = [
            {"date": date(2020, 8, 28), "open": 400, "high": 405, "low": 395, "close": 400, "volume": 10},
            {"date": date(2020, 8, 31), "open": 100, "high": 101, "low": 99, "close": 100, "volume": 40},
        ]
        rows = p.compute_symbol_rows(bars, {}, {date(2020, 8, 31): 4.0})
        self.assertAlmostEqual(rows[1]["ret_1d"], 0.0)  # (100*4)/400 - 1
        self.assertAlmostEqual(rows[0]["adj_close"], 100.0)  # 400 * 0.25
        self.assertAlmostEqual(rows[1]["adj_close"], 100.0)

    def test_total_return_includes_dividend(self):
        bars = [
            {"date": date(2024, 1, 2), "open": 100, "high": 100, "low": 100, "close": 100, "volume": 5},
            {"date": date(2024, 1, 3), "open": 101, "high": 101, "low": 101, "close": 101, "volume": 5},
        ]
        rows = p.compute_symbol_rows(bars, {date(2024, 1, 3): 1.0}, {})
        self.assertAlmostEqual(rows[1]["ret_1d"], 0.01)
        self.assertAlmostEqual(rows[1]["tr_1d"], 0.02)  # (101 + 1)/100 - 1

    def test_dq_flags(self):
        bars = [
            {"date": date(2024, 1, 2), "open": 10, "high": 5, "low": 10, "close": 8, "volume": 0},  # high<low, zero_vol
            {"date": date(2024, 1, 3), "open": 8, "high": 210, "low": 8, "close": 200, "volume": 100},  # +2400% jump
        ]
        rows = p.compute_symbol_rows(bars, {}, {})
        self.assertIn("high_lt_low", rows[0]["dq_flags"])
        self.assertIn("zero_volume", rows[0]["dq_flags"])
        self.assertIn("jump_no_action", rows[1]["dq_flags"])


if __name__ == "__main__":
    unittest.main()
