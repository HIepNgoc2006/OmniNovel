import pytest
from app.novel.token_estimator import ConservativeTokenEstimator, TokenEstimator


def test_conservative_token_estimator_cjk_weight():
    estimator = ConservativeTokenEstimator(cjk_token_weight=2.0, non_cjk_char_weight=0.3)
    
    # 5 ký tự CJK (Kanji/Kana) -> 5 * 2.0 = 10 tokens
    cjk_text = "こんにちは世界"
    assert estimator.estimate_tokens(cjk_text) == 14  # 7 CJK chars * 2.0 = 14


def test_conservative_token_estimator_latin_text():
    estimator = ConservativeTokenEstimator(cjk_token_weight=2.0, non_cjk_char_weight=0.3)
    
    latin_text = "Hello World 123"  # 15 chars * 0.3 = 4.5 -> 5 tokens
    assert estimator.estimate_tokens(latin_text) == 5


def test_conservative_token_estimator_empty():
    estimator = ConservativeTokenEstimator()
    assert estimator.estimate_tokens("") == 0
    assert estimator.estimate_tokens("   ") >= 1


def test_conservative_token_estimator_block_overhead():
    estimator = ConservativeTokenEstimator(block_overhead_tokens=10)
    text = "魔王"  # 2 CJK * 2.0 = 4 tokens
    assert estimator.estimate_block_tokens(text) == 14


def test_custom_token_estimator_protocol():
    class CustomEstimator:
        def estimate_tokens(self, text: str) -> int:
            return len(text.split())

    custom = CustomEstimator()
    assert isinstance(custom, TokenEstimator)
    assert custom.estimate_tokens("word1 word2 word3") == 3
