import unittest
from datetime import date, datetime, timezone

from pipeline.layer2 import calendar_logic as cal

UTC = timezone.utc


class TestCalendar(unittest.TestCase):
    def test_links_and_early_close(self):
        sessions = [
            (date(2024, 7, 2), datetime(2024, 7, 2, 13, 30, tzinfo=UTC), datetime(2024, 7, 2, 20, 0, tzinfo=UTC)),
            (date(2024, 7, 3), datetime(2024, 7, 3, 13, 30, tzinfo=UTC), datetime(2024, 7, 3, 17, 0, tzinfo=UTC)),  # half day
            (date(2024, 7, 5), datetime(2024, 7, 5, 13, 30, tzinfo=UTC), datetime(2024, 7, 5, 20, 0, tzinfo=UTC)),
        ]
        rows = cal.shape_calendar(sessions)
        self.assertEqual(len(rows), 3)
        self.assertFalse(rows[0]["is_early_close"])
        self.assertTrue(rows[1]["is_early_close"])  # 17:00 UTC close
        self.assertIsNone(rows[0]["prev_trading_day"])
        self.assertEqual(rows[1]["prev_trading_day"], datetime(2024, 7, 2, tzinfo=UTC))
        self.assertEqual(rows[1]["next_trading_day"], datetime(2024, 7, 5, tzinfo=UTC))
        self.assertIsNone(rows[2]["next_trading_day"])


if __name__ == "__main__":
    unittest.main()
