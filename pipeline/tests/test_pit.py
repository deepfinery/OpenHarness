import unittest
from datetime import date, datetime, timezone

from pipeline.core import pit

UTC = timezone.utc


class TestPit(unittest.TestCase):
    def test_eod_known_at_is_1600_et_utc(self):
        ka = pit.eod_known_at(date(2024, 6, 3))
        self.assertEqual(ka.tzinfo, UTC)
        self.assertEqual(ka, datetime(2024, 6, 3, 16, 0, tzinfo=pit.ET).astimezone(UTC))

    def test_earnings_bmo_before_amc(self):
        self.assertLess(pit.earnings_known_at(date(2024, 6, 3), "bmo"), pit.earnings_known_at(date(2024, 6, 3), "amc"))

    def test_as_of_same_day_for_eod(self):
        sessions = [
            (date(2024, 6, 3), datetime(2024, 6, 3, 13, 30, tzinfo=UTC)),
            (date(2024, 6, 4), datetime(2024, 6, 4, 13, 30, tzinfo=UTC)),
        ]
        ka = datetime(2024, 6, 3, 20, 0, tzinfo=UTC)
        self.assertEqual(pit.as_of_from_known_at(ka, sessions, same_day=True), date(2024, 6, 3))

    def test_as_of_next_session_after_close(self):
        sessions = [
            (date(2024, 6, 3), datetime(2024, 6, 3, 13, 30, tzinfo=UTC)),
            (date(2024, 6, 4), datetime(2024, 6, 4, 13, 30, tzinfo=UTC)),
        ]
        # known_at after 6/3 open -> can't act until 6/4 open
        self.assertEqual(pit.as_of_from_known_at(datetime(2024, 6, 3, 21, 0, tzinfo=UTC), sessions), date(2024, 6, 4))
        # known_at before 6/3 open -> acts 6/3
        self.assertEqual(pit.as_of_from_known_at(datetime(2024, 6, 3, 10, 0, tzinfo=UTC), sessions), date(2024, 6, 3))


if __name__ == "__main__":
    unittest.main()
