import unittest

from pipeline.layer2 import securities_logic as s


class TestMatch(unittest.TestCase):
    def setUp(self):
        self.existing = [
            {"security_id": "SEC_000001", "cik": "320193", "cusips": {"037833100"}, "tickers": {"AAPL"}, "name": "Apple Inc."},
            {"security_id": "SEC_000002", "cik": "789019", "cusips": {"594918104"}, "tickers": {"MSFT"}, "name": "Microsoft Corp"},
        ]

    def test_cik_takes_precedence(self):
        # ticker reused by a different company, but CIK pins identity
        c = {"ticker": "MSFT", "cik": "320193", "cusip": None, "name": "Totally Different"}
        self.assertEqual(s.match_security(c, self.existing), "SEC_000001")

    def test_cusip_match(self):
        c = {"ticker": "NEW", "cik": None, "cusip": "594918104", "name": "x"}
        self.assertEqual(s.match_security(c, self.existing), "SEC_000002")

    def test_ticker_plus_name(self):
        c = {"ticker": "AAPL", "cik": None, "cusip": None, "name": "Apple Inc"}
        self.assertEqual(s.match_security(c, self.existing), "SEC_000001")

    def test_ticker_without_name_similarity_is_no_match(self):
        c = {"ticker": "AAPL", "cik": None, "cusip": None, "name": "Zzzz Unrelated Holdings"}
        self.assertIsNone(s.match_security(c, self.existing))

    def test_unmatched_is_none(self):
        self.assertIsNone(s.match_security({"ticker": "ZZ", "cik": "1", "cusip": "9", "name": "q"}, self.existing))


class TestIntervals(unittest.TestCase):
    def test_noop_when_same_value(self):
        iv = [{"value": "Tech", "valid_from": "2020-01-01", "valid_to": None}]
        self.assertEqual(s.upsert_interval(iv, "Tech", "2024-01-01"), iv)

    def test_closes_and_opens_on_change(self):
        iv = [{"value": "Tech", "valid_from": "2020-01-01", "valid_to": None}]
        out = s.upsert_interval(iv, "Healthcare", "2024-01-01")
        self.assertEqual(out[0]["valid_to"], "2024-01-01")
        self.assertEqual(out[1], {"value": "Healthcare", "valid_from": "2024-01-01", "valid_to": None})

    def test_ticker_on_and_collision(self):
        from datetime import date

        idents = [
            {"type": "ticker", "value": "FB", "valid_from": date(2012, 1, 1), "valid_to": date(2022, 6, 9)},
            {"type": "ticker", "value": "META", "valid_from": date(2022, 6, 9), "valid_to": None},
        ]
        self.assertEqual(s.ticker_on(idents, date(2015, 1, 1)), "FB")
        self.assertEqual(s.ticker_on(idents, date(2023, 1, 1)), "META")
        a = [{"identifiers": idents}, {"identifiers": [{"type": "ticker", "value": "META", "valid_from": date(2022, 6, 9), "valid_to": None}]}]
        self.assertEqual(s.has_ticker_collision(a, date(2023, 1, 1)), ["META"])


if __name__ == "__main__":
    unittest.main()
