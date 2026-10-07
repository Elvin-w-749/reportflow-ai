"""Strict local OCR helper for first-page report ownership fields.

The PNG arrives on stdin and a small JSON object is written to stdout. No
report text is persisted or logged. Model paths must be provided explicitly so
production never downloads a model while handling a report.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import re
import sys
import unicodedata
from pathlib import Path


MAX_INPUT_BYTES = 12 * 1024 * 1024
CONFIDENCE_FLOOR = 0.90
NAME_RE = re.compile(
    r"姓名[:：]?([\u3400-\u9fff·]{2,8})(?=证件类型|证件号码|身份证|婚姻|报告|$)"
)
IDENTITY_RE = re.compile(
    r"(?:证件号码|身份证号码|公民身份号码)[:：]?([1-9]\d{16}[0-9Xx])"
)
WEIGHTS = (7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2)
CHECKS = ("1", "0", "X", "9", "8", "7", "6", "5", "4", "3", "2")
MODEL_FILES = (
    (
        "PP-OCRv6_det_small.onnx",
        "090f04abcd9d9a7498bc4ebf677e4cb9bdce1fe4197ddb7e529f1ef44e1ff94f",
    ),
    (
        "ch_ppocr_mobile_v2.0_cls_mobile.onnx",
        "e47acedf663230f8863ff1ab0e64dd2d82b838fceb5957146dab185a89d6215c",
    ),
    (
        "PP-OCRv6_rec_small.onnx",
        "6f327246b50388f3c176ae304bd95767ea6dc0c9ae92153ef8cbe210b3c14884",
    ),
)


def safe_result(reason: str) -> dict[str, object]:
    return {"ok": False, "ambiguous": False, "reason": reason}


def normalize_text(value: object) -> str:
    text = unicodedata.normalize("NFKC", str(value or ""))
    return re.sub(r"\s+", "", text).strip()


def valid_identity(value: str) -> bool:
    identity = str(value or "").upper()
    if not re.fullmatch(r"\d{17}[\dX]", identity):
        return False
    total = sum(int(identity[index]) * WEIGHTS[index] for index in range(17))
    return CHECKS[total % 11] == identity[-1]


def confidence_threshold() -> float:
    try:
        configured = float(os.environ.get("RAPIDOCR_MIN_CONFIDENCE", CONFIDENCE_FLOOR))
    except ValueError:
        configured = CONFIDENCE_FLOOR
    return max(CONFIDENCE_FLOOR, min(1.0, configured))


def file_sha256(file_path: Path) -> str:
    digest = hashlib.sha256()
    with file_path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def manifest_hashes(manifest_path: Path) -> dict[str, str] | None:
    entries: dict[str, str] = {}
    try:
        for raw_line in manifest_path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line:
                continue
            match = re.fullmatch(r"([a-fA-F0-9]{64})\s{2,}(.+)", line)
            if match is None:
                return None
            file_name = match.group(2).strip()
            if Path(file_name).name != file_name or file_name in entries:
                return None
            entries[file_name] = match.group(1).lower()
    except OSError:
        return None
    return entries


def model_paths() -> tuple[str, str, str] | None:
    values = tuple(
        os.environ.get(key, "").strip()
        for key in ("RAPIDOCR_DET_MODEL", "RAPIDOCR_CLS_MODEL", "RAPIDOCR_REC_MODEL")
    )
    manifest_value = os.environ.get("RAPIDOCR_MODEL_MANIFEST", "").strip()
    if not all(values) or not manifest_value:
        return None
    paths = tuple(Path(value) for value in values)
    manifest_path = Path(manifest_value)
    if (
        not manifest_path.is_absolute()
        or not all(model_path.is_absolute() for model_path in paths)
        or not all(model_path.is_file() for model_path in paths)
        or not manifest_path.is_file()
    ):
        return None
    entries = manifest_hashes(manifest_path)
    if entries is None or len(entries) != len(MODEL_FILES):
        return None
    try:
        for model_path, (expected_name, expected_hash) in zip(paths, MODEL_FILES, strict=True):
            if model_path.name != expected_name:
                return None
            if not hmac.compare_digest(entries.get(expected_name, ""), expected_hash):
                return None
            if not hmac.compare_digest(file_sha256(model_path), expected_hash):
                return None
    except OSError:
        return None
    return tuple(str(model_path) for model_path in paths)  # type: ignore[return-value]


def extract_candidate(texts: list[str], scores: list[float]) -> dict[str, object]:
    threshold = confidence_threshold()
    names: dict[str, float] = {}
    identities: dict[str, float] = {}

    for index, raw_text in enumerate(texts):
        text = normalize_text(raw_text)
        score = float(scores[index]) if index < len(scores) else 0.0
        if score < threshold:
            continue
        for match in NAME_RE.finditer(text):
            name = match.group(1)
            names[name] = max(score, names.get(name, 0.0))
        for match in IDENTITY_RE.finditer(text):
            identity = match.group(1).upper()
            if valid_identity(identity):
                identities[identity] = max(score, identities.get(identity, 0.0))

    if len(names) != 1 or len(identities) != 1:
        result = safe_result("ambiguous" if len(names) > 1 or len(identities) > 1 else "incomplete")
        result["ambiguous"] = len(names) > 1 or len(identities) > 1
        return result

    name, name_score = next(iter(names.items()))
    identity, identity_score = next(iter(identities.items()))
    return {
        "ok": True,
        "ambiguous": False,
        "name": name,
        "fullId": identity,
        "nameConfidence": round(name_score, 6),
        "identityConfidence": round(identity_score, 6),
    }


def main() -> int:
    paths = model_paths()
    if paths is None:
        json.dump(safe_result("configuration"), sys.stdout, ensure_ascii=False)
        return 2

    data = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
    if not data or len(data) > MAX_INPUT_BYTES:
        json.dump(safe_result("input"), sys.stdout, ensure_ascii=False)
        return 2

    logging.disable(logging.CRITICAL)
    try:
        from rapidocr import RapidOCR

        detector, classifier, recognizer = paths
        engine = RapidOCR(
            params={
                "Det.model_path": detector,
                "Cls.model_path": classifier,
                "Rec.model_path": recognizer,
            }
        )
        output = engine(data)
        texts = [] if output.txts is None else [str(value) for value in list(output.txts)]
        scores = [] if output.scores is None else [float(value) for value in list(output.scores)]
        json.dump(extract_candidate(texts, scores), sys.stdout, ensure_ascii=False, separators=(",", ":"))
        return 0
    except Exception:
        json.dump(safe_result("runtime"), sys.stdout, ensure_ascii=False)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
