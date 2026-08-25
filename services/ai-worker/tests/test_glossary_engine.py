from app.translation.glossary_engine import GlossaryEngine, GlossaryEntry


def test_glossary_longest_match_first():
    entries = [
        GlossaryEntry(source_term="超サイヤ人", target_term="Siêu Saiyan", category="POWER"),
        GlossaryEntry(source_term="超サイヤ人ゴッド", target_term="Siêu Saiyan God", category="POWER"),
    ]
    engine = GlossaryEngine(entries)

    text = "悟空は超サイヤ人ゴッドに変身した。"
    constraints = engine.find_constraints(text)

    # Invariant: Khớp thuật ngữ dài hơn trước (超サイヤ人ゴッド), không bị cắt vụn bởi 超サイヤ人
    assert len(constraints) == 1
    assert constraints[0].source_term == "超サイヤ人ゴッド"
    assert constraints[0].target_term == "Siêu Saiyan God"


def test_glossary_half_full_width_normalization():
    entries = [
        GlossaryEntry(source_term="ABC", target_term="Liên minh ABC", category="FACTION"),
    ]
    engine = GlossaryEngine(entries)

    # Text chứa ký tự full-width ＡＢＣ
    text = "我らはＡＢＣの戦士だ！"
    constraints = engine.find_constraints(text)

    assert len(constraints) == 1
    assert constraints[0].source_term == "ABC"
    assert constraints[0].target_term == "Liên minh ABC"


def test_glossary_raw_text_never_mutated():
    entries = [
        GlossaryEntry(source_term="ルフィ", target_term="Luffy", category="CHARACTER_NAME"),
    ]
    engine = GlossaryEngine(entries)

    canonical_raw_text = "ルフィは海賊王になる男だ！"
    constraints = engine.find_constraints(canonical_raw_text)

    assert len(constraints) == 1
    # Invariant: raw_text gốc không hề bị thay đổi hay ghi đè
    assert canonical_raw_text == "ルフィは海賊王になる男だ！"


def test_glossary_multiple_terms_in_bubble():
    entries = [
        GlossaryEntry(source_term="ルフィ", target_term="Luffy", category="CHARACTER_NAME"),
        GlossaryEntry(source_term="ゾロ", target_term="Zoro", category="CHARACTER_NAME"),
        GlossaryEntry(source_term="ナミ", target_term="Nami", category="CHARACTER_NAME"),
    ]
    engine = GlossaryEngine(entries)

    text = "ルフィとゾロとナミが来た！"
    constraints = engine.find_constraints(text)

    assert len(constraints) == 3
    matched_targets = {c.target_term for c in constraints}
    assert matched_targets == {"Luffy", "Zoro", "Nami"}


def test_glossary_empty_and_whitespace_handling():
    engine = GlossaryEngine([])
    assert engine.find_constraints("こんにちは") == []

    engine2 = GlossaryEngine([GlossaryEntry(source_term="   ", target_term="X")])
    assert engine2.find_constraints("こんにちは") == []
