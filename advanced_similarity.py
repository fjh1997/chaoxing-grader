#!/usr/bin/env python3
import argparse
from concurrent.futures import ProcessPoolExecutor, as_completed
import csv
import hashlib
import json
import math
import os
import re
import sys
from pathlib import Path

import cv2
import numpy as np


RUN_DIR = Path(sys.argv[1] if len(sys.argv) > 1 else "runs/example")
MANUAL_EVIDENCE_FILE = "manual_similarity_evidence.json"
IMAGE_CACHE = {}
FEATURE_CACHE = {}
EVIDENCE_TOKEN_CACHE = {}
MAX_COMPARE_IMAGES = int(os.environ.get("MAX_COMPARE_IMAGES", "3"))
MAX_IMAGE_DIM = int(os.environ.get("SIMILARITY_MAX_IMAGE_DIM", "1400"))
FEATURE_CACHE_DIR = None
USE_FEATURE_CACHE = os.environ.get("SIMILARITY_FEATURE_CACHE", "1") != "0"
FORCE_FEATURE_CACHE = False
WORKER_SUBMISSIONS_BY_ID = {}
WORKER_MANUAL_EVIDENCE = {}
COMMON_OBJECT_IDS = set()
COMMON_SHA256 = set()
COMMON_EVIDENCE_TOKENS = set()


def parse_args(argv):
    parser = argparse.ArgumentParser(description="Advanced image/evidence similarity detector for Chaoxing submissions.")
    parser.add_argument("run_dir", nargs="?", default="runs/example")
    parser.add_argument("--workers", type=int, default=int(os.environ.get("SIMILARITY_WORKERS", "0")),
                        help="parallel worker processes; default auto-selects up to 8")
    parser.add_argument("--max-compare-images", type=int, default=int(os.environ.get("MAX_COMPARE_IMAGES", "3")))
    parser.add_argument("--no-feature-cache", action="store_true", help="disable on-disk SIFT/AKAZE feature cache")
    parser.add_argument("--force-feature-cache", action="store_true", help="rebuild on-disk feature cache")
    parser.add_argument("--no-precompute", action="store_true", help="skip feature-cache warmup before pair matching")
    return parser.parse_args(argv)


def default_workers(requested):
    if requested and requested > 0:
        return requested
    cpu = os.cpu_count() or 1
    return max(1, min(8, cpu - 1 if cpu > 2 else cpu))


def init_worker(run_dir, max_compare_images, feature_cache_dir, use_feature_cache, force_feature_cache,
                submissions_by_id=None, manual_evidence=None, common_object_ids=None, common_sha256=None,
                common_evidence_tokens=None):
    global RUN_DIR, MAX_COMPARE_IMAGES, FEATURE_CACHE_DIR, USE_FEATURE_CACHE, FORCE_FEATURE_CACHE
    global WORKER_SUBMISSIONS_BY_ID, WORKER_MANUAL_EVIDENCE, COMMON_OBJECT_IDS, COMMON_SHA256, COMMON_EVIDENCE_TOKENS
    RUN_DIR = Path(run_dir)
    MAX_COMPARE_IMAGES = int(max_compare_images)
    FEATURE_CACHE_DIR = Path(feature_cache_dir) if feature_cache_dir else None
    USE_FEATURE_CACHE = bool(use_feature_cache)
    FORCE_FEATURE_CACHE = bool(force_feature_cache)
    if submissions_by_id is not None:
        WORKER_SUBMISSIONS_BY_ID = submissions_by_id
    if manual_evidence is not None:
        WORKER_MANUAL_EVIDENCE = manual_evidence
    if common_object_ids is not None:
        COMMON_OBJECT_IDS = set(common_object_ids)
    if common_sha256 is not None:
        COMMON_SHA256 = set(common_sha256)
    if common_evidence_tokens is not None:
        COMMON_EVIDENCE_TOKENS = set(common_evidence_tokens)
    try:
        cv2.setNumThreads(max(1, int(os.environ.get("OPENCV_THREADS_PER_WORKER", "1"))))
    except Exception:
        pass


def load_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def load_submissions():
    rows = []
    for path in sorted((RUN_DIR / "submissions").glob("*.json")):
        row = load_json(path)
        row["_file"] = str(path)
        rows.append(row)
    return rows


def load_manual_evidence():
    path = RUN_DIR / MANUAL_EVIDENCE_FILE
    if not path.exists():
        return {}
    rows = load_json(path)
    evidence = {}
    for row in rows if isinstance(rows, list) else []:
        ids = [str(row.get("aWorkAnswerId") or ""), str(row.get("bWorkAnswerId") or "")]
        if not all(ids):
            continue
        key = tuple(sorted(ids))
        evidence[key] = {
            "verdict": row.get("verdict") or "confirmed",
            "sharedEvidence": row.get("sharedEvidence") or "",
            "evidenceSimilarity": float(row.get("evidenceSimilarity") or 1.0),
            "note": row.get("note") or "",
        }
    return evidence


def vision_for(sub):
    path = RUN_DIR / "vision" / f"{sub['className']}_{sub['studentNo']}_{sub['name']}_{sub['workAnswerId']}.json"
    if path.exists():
        return load_json(path)
    return sub.get("vision") or {}


def real_object_id(asset):
    object_id = str(asset.get("objectId") or "")
    if object_id and not re.fullmatch(r"image_\d+", object_id):
        return object_id
    src = str(asset.get("src") or "")
    m = re.search(r"/([0-9a-fA-F]{16,})\.(?:png|jpe?g|gif|webp)(?:[?#].*)?$", src)
    return m.group(1) if m else ""


def first_image_path(sub):
    for asset in sub.get("assets") or []:
        if asset.get("ok") and asset.get("file") and not is_common_asset(asset):
            return RUN_DIR / asset["file"]
    return None


def image_assets(sub):
    rows = []
    for index, asset in enumerate(sub.get("assets") or [], start=1):
        if not asset.get("ok") or not asset.get("file"):
            continue
        if is_common_asset(asset):
            continue
        rows.append({
            "index": index,
            "file": asset["file"],
            "path": RUN_DIR / asset["file"],
            "objectId": asset.get("objectId") or "",
            "sha256": asset.get("sha256") or "",
        })
    return rows[:MAX_COMPARE_IMAGES]


def build_common_assets(submissions):
    object_counts = {}
    sha_counts = {}
    for sub in submissions:
        objects = set()
        hashes = set()
        for asset in sub.get("assets") or []:
            if not asset.get("ok"):
                continue
            object_id = real_object_id(asset)
            if object_id:
                objects.add(object_id)
            sha = asset.get("sha256")
            if sha:
                hashes.add(str(sha))
        for object_id in objects:
            object_counts[object_id] = object_counts.get(object_id, 0) + 1
        for sha in hashes:
            sha_counts[sha] = sha_counts.get(sha, 0) + 1

    n = max(1, len(submissions))
    min_freq = int(os.environ.get("COMMON_ASSET_MIN_FREQ", "5"))
    min_ratio = float(os.environ.get("COMMON_ASSET_MIN_RATIO", "0.20"))
    common_objects = {k for k, count in object_counts.items() if count >= min_freq and count / n >= min_ratio}
    common_hashes = {k for k, count in sha_counts.items() if count >= min_freq and count / n >= min_ratio}
    return common_objects, common_hashes


def is_common_asset(asset):
    object_id = real_object_id(asset)
    sha = str(asset.get("sha256") or "")
    return (object_id and object_id in COMMON_OBJECT_IDS) or (sha and sha in COMMON_SHA256)


def image_hash_similarity(a, b):
    a_hashes = [x.get("ahash") for x in a.get("assets") or [] if x.get("ok") and x.get("ahash") and not is_common_asset(x)]
    b_hashes = [x.get("ahash") for x in b.get("assets") or [] if x.get("ok") and x.get("ahash") and not is_common_asset(x)]
    if not a_hashes or not b_hashes:
        return 0.0
    best = 0.0
    for ah in a_hashes:
        for bh in b_hashes:
            n = min(len(ah), len(bh))
            if n == 0:
                continue
            dist = sum(1 for x, y in zip(ah[:n], bh[:n]) if x != y) + abs(len(ah) - len(bh))
            best = max(best, 1 - dist / max(len(ah), len(bh), 1))
    return best


def evidence_text(sub):
    v = vision_for(sub)
    review = sub.get("review") or {}
    return "\n".join([
        str(v.get("extractedText") or ""),
        str(v.get("summary") or ""),
        str(v.get("comment") or ""),
        str(review.get("answerText") or ""),
    ]).lower()


EVIDENCE_PATTERNS = [
    re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b"),
    re.compile(r"\b(?:nc|ncat)\s+-[a-z]*\s*(?:\d{2,5})\b"),
    re.compile(r"\blistening\s+on\s+(?:\d{1,3}\.){3}\d{1,3}\s+\d{2,5}\b"),
    re.compile(r"\bconnection\s+received\s+on\s+(?:\d{1,3}\.){3}\d{1,3}\s+\d{2,5}\b"),
    re.compile(r"\bdocker\s+compose\s+up\s+--build\b"),
    re.compile(r"\bcommand\s+'docker'\s+not\s+found\b"),
    re.compile(r"\b(?:apt\s+install\s+)?(?:docker\.io|podman-docker)\b"),
    re.compile(r"\bbuilding\s+war:\s*\S+\.war\b"),
    re.compile(r"\b[\w.-]+\.war\b"),
    re.compile(r"\b(?:ldap|rmi|http)://[^\s\"'<>]+"),
    re.compile(r"/(?:rce|uvvvi|exec|exectemplate)[\w.-]*"),
    re.compile(r"\bexectemplatejdk8(?:\.class)?\b"),
    re.compile(r"\brce[-_][a-z0-9_-]+"),
    re.compile(r"\bsqli\b"),
]


def evidence_tokens(sub):
    key = str(sub.get("workAnswerId") or "")
    if key in EVIDENCE_TOKEN_CACHE:
        return EVIDENCE_TOKEN_CACHE[key]
    text = evidence_text(sub)
    tokens = set()
    for pattern in EVIDENCE_PATTERNS:
        for match in pattern.findall(text):
            tokens.add(re.sub(r"\s+", " ", match).strip())
    EVIDENCE_TOKEN_CACHE[key] = tokens
    return tokens


def build_common_evidence_tokens(submissions):
    token_counts = {}
    for sub in submissions:
        for token in evidence_tokens(sub):
            token_counts[token] = token_counts.get(token, 0) + 1
    n = max(1, len(submissions))
    min_freq = int(os.environ.get("COMMON_EVIDENCE_MIN_FREQ", "5"))
    min_ratio = float(os.environ.get("COMMON_EVIDENCE_MIN_RATIO", "0.20"))
    return {
        token
        for token, count in token_counts.items()
        if count >= min_freq and count / n >= min_ratio
    }


def evidence_similarity(a, b):
    ta = evidence_tokens(a) - COMMON_EVIDENCE_TOKENS
    tb = evidence_tokens(b) - COMMON_EVIDENCE_TOKENS
    if len(ta) < 3 or len(tb) < 3:
        return 0.0, []
    shared = sorted(ta & tb)
    union = ta | tb
    jaccard = len(shared) / len(union) if union else 0.0
    containment = len(shared) / min(len(ta), len(tb))
    return max(jaccard, containment), shared


def load_gray(path, max_dim=None):
    if max_dim is None:
        max_dim = MAX_IMAGE_DIM
    key = (str(path), max_dim)
    if key in IMAGE_CACHE:
        return IMAGE_CACHE[key]
    img = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE)
    if img is None:
        return None
    h, w = img.shape
    scale = min(1.0, max_dim / max(h, w))
    if scale < 1:
        img = cv2.resize(img, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
    IMAGE_CACHE[key] = img
    return img


def feature_cache_file(path, method):
    if not FEATURE_CACHE_DIR:
        return None
    try:
        st = Path(path).stat()
        identity = f"{Path(path).resolve()}|{st.st_size}|{int(st.st_mtime_ns)}|{method}|{MAX_IMAGE_DIM}"
    except OSError:
        identity = f"{Path(path).resolve()}|missing|{method}|{MAX_IMAGE_DIM}"
    digest = hashlib.sha256(identity.encode("utf-8")).hexdigest()
    return FEATURE_CACHE_DIR / method / f"{digest}.npz"


def encode_keypoints(keypoints):
    if not keypoints:
        return np.empty((0, 7), dtype=np.float32)
    return np.array([
        [kp.pt[0], kp.pt[1], kp.size, kp.angle, kp.response, kp.octave, kp.class_id]
        for kp in keypoints
    ], dtype=np.float32)


def decode_keypoints(rows):
    out = []
    for row in np.asarray(rows, dtype=np.float32):
        out.append(cv2.KeyPoint(
            float(row[0]), float(row[1]), float(row[2]),
            float(row[3]), float(row[4]), int(row[5]), int(row[6])
        ))
    return out


def save_feature_cache(cache_file, shape, keypoints, descriptors):
    if not cache_file:
        return
    try:
        cache_file.parent.mkdir(parents=True, exist_ok=True)
        desc = descriptors if descriptors is not None else np.empty((0, 0), dtype=np.float32)
        np.savez_compressed(
            cache_file,
            shape=np.array(shape, dtype=np.int32),
            keypoints=encode_keypoints(keypoints),
            descriptors=desc,
        )
    except Exception:
        pass


def load_feature_cache(cache_file):
    if not cache_file or FORCE_FEATURE_CACHE or not cache_file.exists():
        return None
    try:
        data = np.load(cache_file, allow_pickle=False)
        shape = tuple(int(x) for x in data["shape"].tolist())
        keypoints = decode_keypoints(data["keypoints"])
        descriptors = data["descriptors"]
        if descriptors.size == 0:
            descriptors = None
        return shape, keypoints, descriptors
    except Exception:
        return None


def image_features(path, method):
    key = (str(path), method)
    if key in FEATURE_CACHE:
        return FEATURE_CACHE[key]
    cache_file = feature_cache_file(path, method) if USE_FEATURE_CACHE else None
    cached = load_feature_cache(cache_file)
    if cached is not None:
        shape, keypoints, descriptors = cached
        FEATURE_CACHE[key] = (shape, keypoints, descriptors)
        return FEATURE_CACHE[key]
    img = load_gray(path)
    if img is None:
        FEATURE_CACHE[key] = (None, None, None)
        return FEATURE_CACHE[key]
    if method == "sift":
        detector = cv2.SIFT_create(nfeatures=4000, contrastThreshold=0.01)
    else:
        detector = cv2.AKAZE_create()
    keypoints, descriptors = detector.detectAndCompute(img, None)
    shape = img.shape
    save_feature_cache(cache_file, shape, keypoints, descriptors)
    FEATURE_CACHE[key] = (shape, keypoints, descriptors)
    return FEATURE_CACHE[key]


def local_match(a_path, b_path, method):
    shape_a, k1, d1 = image_features(a_path, method)
    shape_b, k2, d2 = image_features(b_path, method)
    if shape_a is None or shape_b is None:
        return {"good": 0, "inliers": 0, "ratio": 0.0, "coverage": 0.0}
    norm = cv2.NORM_L2 if method == "sift" else cv2.NORM_HAMMING
    if d1 is None or d2 is None or len(k1) < 4 or len(k2) < 4:
        return {"good": 0, "inliers": 0, "ratio": 0.0, "coverage": 0.0}
    matches = cv2.BFMatcher(norm).knnMatch(d1, d2, k=2)
    good = []
    for pair in matches:
        if len(pair) < 2:
            continue
        m, n = pair
        if m.distance < 0.75 * n.distance:
            good.append(m)
    inliers = 0
    coverage = 0.0
    if len(good) >= 4:
        src = np.float32([k1[m.queryIdx].pt for m in good]).reshape(-1, 1, 2)
        dst = np.float32([k2[m.trainIdx].pt for m in good]).reshape(-1, 1, 2)
        _, mask = cv2.findHomography(src, dst, cv2.RANSAC, 5.0)
        if mask is not None:
            keep = mask.ravel().astype(bool)
            inliers = int(keep.sum())
            pts = src[keep].reshape(-1, 2)
            if len(pts) >= 4:
                _, _, w, h = cv2.boundingRect(pts.astype(np.float32))
                coverage = (w * h) / (shape_a[0] * shape_a[1])
    denom = max(1, min(len(k1), len(k2)))
    return {
        "good": len(good),
        "inliers": inliers,
        "ratio": inliers / denom,
        "coverage": coverage,
    }


def empty_local_match():
    return {
        "good": 0,
        "inliers": 0,
        "ratio": 0.0,
        "coverage": 0.0,
        "aFile": "",
        "bFile": "",
        "aImageIndex": "",
        "bImageIndex": "",
    }


def local_rank(match):
    return (
        int(match.get("inliers") or 0),
        float(match.get("ratio") or 0),
        float(match.get("coverage") or 0),
        int(match.get("good") or 0),
    )


def best_local_match(a, b, method):
    best = empty_local_match()
    for aa in image_assets(a):
        for bb in image_assets(b):
            result = local_match(aa["path"], bb["path"], method)
            result.update({
                "aFile": aa["file"],
                "bFile": bb["file"],
                "aImageIndex": aa["index"],
                "bImageIndex": bb["index"],
            })
            if local_rank(result) > local_rank(best):
                best = result
    return best


def exact_match(a, b):
    a_assets = [x for x in a.get("assets") or [] if x.get("ok") and not is_common_asset(x)]
    b_assets = [x for x in b.get("assets") or [] if x.get("ok") and not is_common_asset(x)]
    a_obj = {real_object_id(x) for x in a_assets if real_object_id(x)}
    b_obj = {real_object_id(x) for x in b_assets if real_object_id(x)}
    a_sha = {x.get("sha256") for x in a_assets if x.get("sha256")}
    b_sha = {x.get("sha256") for x in b_assets if x.get("sha256")}
    return bool(a_obj & b_obj), bool(a_sha & b_sha), sorted((a_obj & b_obj) | (a_sha & b_sha))


def high_specific_evidence(ev_score, ev_shared):
    shared = set(str(x).lower() for x in (ev_shared or []))
    has_rce_path = any(re.search(r"/rce[-_][a-z0-9_.-]*(?:b327|root|whoami|hostname)", x) for x in shared)
    has_attacker_ip = any(re.search(r"\b(?:10|100|172|192|[1-9]\d?)\.\d{1,3}\.\d{1,3}\.\d{1,3}\b", x) for x in shared)
    has_target_or_server = any(re.search(r"(?:\b\d{1,3}(?:\.\d{1,3}){3}\b|https?://0\.0\.0\.0:\d{2,5})", x) for x in shared)
    return ev_score >= 0.95 and has_rce_path and has_attacker_ip and has_target_or_server


def is_xss_cookie_assignment():
    text = str(RUN_DIR).lower()
    return "xss" in text and "cookie" in text


def decision_details(exact_obj, exact_sha, hash_sim, sift, akaze, ev_score, ev_shared=None):
    if exact_obj or exact_sha:
        return "confirmed", "同一上传对象或同一图片文件"
    if high_specific_evidence(ev_score, ev_shared):
        return "confirmed", "多项唯一回连证据完全一致"
    very_strong_visual = (
        float(hash_sim or 0) >= 0.97
        and sift["inliers"] >= 500 and sift["ratio"] >= 0.35 and sift["coverage"] >= 0.45
        and akaze["inliers"] >= 250 and akaze["ratio"] >= 0.18 and akaze["coverage"] >= 0.40
    )
    strong_local = (
        (sift["inliers"] >= 300 and sift["ratio"] >= 0.18 and sift["coverage"] >= 0.45)
        or (akaze["inliers"] >= 250 and akaze["ratio"] >= 0.18 and akaze["coverage"] >= 0.45)
    )
    moderate_local = (
        (sift["inliers"] >= 150 and sift["ratio"] >= 0.08)
        or (akaze["inliers"] >= 120 and akaze["ratio"] >= 0.08)
    )
    very_strong_local = (
        sift["inliers"] >= 1500 and sift["ratio"] >= 0.40 and sift["coverage"] >= 0.75
        and akaze["inliers"] >= 1500 and akaze["ratio"] >= 0.60 and akaze["coverage"] >= 0.50
    )
    scaled_same_screenshot = (
        sift["inliers"] >= 500 and sift["ratio"] >= 0.35 and sift["coverage"] >= 0.45
    )
    dual_engine_same_region = (
        sift["inliers"] >= 500 and sift["ratio"] >= 0.24 and sift["coverage"] >= 0.45
        and akaze["inliers"] >= 400 and akaze["ratio"] >= 0.24 and akaze["coverage"] >= 0.42
    )
    if is_xss_cookie_assignment() and (
        very_strong_visual
        or very_strong_local
        or dual_engine_same_region
        or scaled_same_screenshot
        or strong_local
        or (moderate_local and ev_score >= 0.65)
        or ev_score >= 0.8
    ):
        return "suspected", "XSS Cookie 实验请求日志天然相似，非同一文件的视觉匹配降为疑似"
    if very_strong_visual:
        return "confirmed", "图片哈希接近一致，且 SIFT/AKAZE 在同一区域强匹配"
    if very_strong_local and ev_score >= 0.65:
        return "confirmed", "SIFT/AKAZE 极强局部匹配且核心证据高度一致"
    if dual_engine_same_region and ev_score >= 0.50:
        return "confirmed", "SIFT/AKAZE 双引擎确认同一区域，且共享关键回连证据"
    if scaled_same_screenshot and ev_score >= 0.35:
        return "confirmed", "SIFT 检出缩放/裁剪后的同一截图，且共享利用链核心证据"
    if strong_local and ev_score >= 0.95:
        return "confirmed", "强局部匹配且核心证据完全一致"
    if strong_local or (moderate_local and ev_score >= 0.65) or ev_score >= 0.8:
        return "suspected", "局部视觉或核心证据相似，但未达到自动置零阈值"
    return "ignore", "未达到相似阈值"


def decision(exact_obj, exact_sha, sift, akaze, ev_score):
    verdict, _ = decision_details(exact_obj, exact_sha, 0.0, sift, akaze, ev_score)
    return verdict


def candidate_pairs(submissions, manual_evidence=None):
    n = len(submissions)
    pairs = set()
    sim_file = RUN_DIR / "similarity_report.json"
    if sim_file.exists():
        sim_rows = load_json(sim_file)
        # The base n-gram similarity report can explode to all pairs when many
        # submissions share generic rubric text. Treat it only as a hint when it
        # is selective; otherwise rely on exact/image/evidence filters below.
        max_hint_pairs = max(200, n * 8)
        if len(sim_rows) <= max_hint_pairs:
            for pair in sim_rows:
                pairs.add(tuple(sorted([str(pair["aWorkAnswerId"]), str(pair["bWorkAnswerId"])])))
    by_id = {str(s["workAnswerId"]): s for s in submissions}
    rows = list(by_id.values())
    for i in range(n):
        for j in range(i + 1, n):
            a, b = rows[i], rows[j]
            ev, _ = evidence_similarity(a, b)
            hash_sim = image_hash_similarity(a, b)
            exact_obj, exact_sha, _ = exact_match(a, b)
            if (
                exact_obj
                or exact_sha
                or hash_sim >= 0.92
                or ev >= 0.75
                or (ev >= 0.45 and hash_sim >= 0.65)
                or (ev >= 0.40 and hash_sim >= 0.45)
            ):
                pairs.add(tuple(sorted([str(a["workAnswerId"]), str(b["workAnswerId"])])))
    for key in (manual_evidence or {}).keys():
        pairs.add(tuple(sorted(key)))
    return [(by_id[a], by_id[b]) for a, b in sorted(pairs)]


def pair_key_for(a, b):
    return tuple(sorted([str(a["workAnswerId"]), str(b["workAnswerId"])]))


def compute_pair(a, b, manual_evidence=None):
    a_path = first_image_path(a)
    b_path = first_image_path(b)
    exact_obj, exact_sha, exact_shared = exact_match(a, b)
    hash_sim = image_hash_similarity(a, b)
    ev_score, ev_shared = evidence_similarity(a, b)
    manual = (manual_evidence or {}).get(pair_key_for(a, b))
    if manual:
        ev_score = max(ev_score, float(manual.get("evidenceSimilarity") or 1.0))
        manual_shared = [x.strip() for x in str(manual.get("sharedEvidence") or "").split(";") if x.strip()]
        ev_shared = sorted(set(ev_shared) | set(manual_shared))
    sift = best_local_match(a, b, "sift") if a_path and b_path else empty_local_match()
    akaze = best_local_match(a, b, "akaze") if a_path and b_path else empty_local_match()
    verdict, reason = decision_details(exact_obj, exact_sha, hash_sim, sift, akaze, ev_score, ev_shared)
    verdict_source = "algorithm"
    if manual and manual.get("verdict"):
        verdict = manual["verdict"]
        reason = f"manual evidence enabled: {manual.get('note') or manual.get('sharedEvidence') or ''}".strip()
        verdict_source = "manual"
    return {
        "verdict": verdict,
        "verdictSource": verdict_source,
        "decisionReason": reason,
        "aClass": a["className"],
        "aName": a["name"],
        "aStudentNo": a["studentNo"],
        "aSubmitTime": a.get("submitTime", ""),
        "aWorkAnswerId": a["workAnswerId"],
        "bClass": b["className"],
        "bName": b["name"],
        "bStudentNo": b["studentNo"],
        "bSubmitTime": b.get("submitTime", ""),
        "bWorkAnswerId": b["workAnswerId"],
        "exactObject": exact_obj,
        "exactFile": exact_sha,
        "exactShared": "; ".join(exact_shared),
        "imageHashSimilarity": round(hash_sim, 4),
        "siftInliers": sift["inliers"],
        "siftRatio": round(sift["ratio"], 4),
        "siftCoverage": round(sift["coverage"], 4),
        "siftAFile": sift.get("aFile") or "",
        "siftBFile": sift.get("bFile") or "",
        "siftAImage": sift.get("aImageIndex") or "",
        "siftBImage": sift.get("bImageIndex") or "",
        "akazeInliers": akaze["inliers"],
        "akazeRatio": round(akaze["ratio"], 4),
        "akazeCoverage": round(akaze["coverage"], 4),
        "akazeAFile": akaze.get("aFile") or "",
        "akazeBFile": akaze.get("bFile") or "",
        "akazeAImage": akaze.get("aImageIndex") or "",
        "akazeBImage": akaze.get("bImageIndex") or "",
        "evidenceSimilarity": round(ev_score, 4),
        "sharedEvidence": "; ".join(ev_shared),
    }


def compute_pair_by_id(task):
    a_id, b_id = task
    return compute_pair(WORKER_SUBMISSIONS_BY_ID[str(a_id)], WORKER_SUBMISSIONS_BY_ID[str(b_id)], WORKER_MANUAL_EVIDENCE)


def feature_cache_tasks(submissions):
    seen = set()
    tasks = []
    for sub in submissions:
        for asset in image_assets(sub):
            path_text = str(asset["path"])
            for method in ("sift", "akaze"):
                key = (path_text, method)
                if key in seen:
                    continue
                seen.add(key)
                tasks.append(key)
    return tasks


def precompute_feature_task(task):
    path_text, method = task
    shape, keypoints, descriptors = image_features(Path(path_text), method)
    return {
        "path": path_text,
        "method": method,
        "keypoints": 0 if keypoints is None else len(keypoints),
        "descriptors": 0 if descriptors is None else len(descriptors),
        "ok": shape is not None,
    }


def precompute_features(submissions, workers):
    if not USE_FEATURE_CACHE:
        return
    tasks = feature_cache_tasks(submissions)
    if not tasks:
        return
    if workers <= 1:
        for task in tasks:
            precompute_feature_task(task)
        return
    completed = 0
    with ProcessPoolExecutor(
        max_workers=workers,
        initializer=init_worker,
        initargs=(
            str(RUN_DIR),
            MAX_COMPARE_IMAGES,
            str(FEATURE_CACHE_DIR),
            USE_FEATURE_CACHE,
            FORCE_FEATURE_CACHE,
            {},
            {},
            COMMON_OBJECT_IDS,
            COMMON_SHA256,
            COMMON_EVIDENCE_TOKENS,
        ),
    ) as executor:
        futures = [executor.submit(precompute_feature_task, task) for task in tasks]
        for future in as_completed(futures):
            future.result()
            completed += 1
    print(f"feature cache ready: {completed} image-method entries")


def main():
    global RUN_DIR, MAX_COMPARE_IMAGES, FEATURE_CACHE_DIR, USE_FEATURE_CACHE, FORCE_FEATURE_CACHE
    args = parse_args(sys.argv[1:])
    RUN_DIR = Path(args.run_dir)
    MAX_COMPARE_IMAGES = int(args.max_compare_images)
    FEATURE_CACHE_DIR = RUN_DIR / ".similarity_feature_cache"
    USE_FEATURE_CACHE = not args.no_feature_cache
    FORCE_FEATURE_CACHE = bool(args.force_feature_cache)
    workers = default_workers(args.workers)

    submissions = load_submissions()
    common_object_ids, common_sha256 = build_common_assets(submissions)
    common_evidence_tokens = build_common_evidence_tokens(submissions)
    init_worker(
        str(RUN_DIR),
        MAX_COMPARE_IMAGES,
        str(FEATURE_CACHE_DIR),
        USE_FEATURE_CACHE,
        FORCE_FEATURE_CACHE,
        common_object_ids=common_object_ids,
        common_sha256=common_sha256,
        common_evidence_tokens=common_evidence_tokens,
    )
    manual_evidence = load_manual_evidence() if os.environ.get("USE_MANUAL_SIMILARITY_EVIDENCE") == "1" else {}
    rows = []
    pairs = candidate_pairs(submissions, manual_evidence)
    print(f"candidate pairs: {len(pairs)}")
    print(f"workers: {workers}, max_compare_images: {MAX_COMPARE_IMAGES}, feature_cache: {'on' if USE_FEATURE_CACHE else 'off'}")
    print(f"common assets ignored: object_ids={len(common_object_ids)}, sha256={len(common_sha256)}")
    print(f"common evidence tokens ignored: {len(common_evidence_tokens)}")

    if not args.no_precompute and USE_FEATURE_CACHE:
        precompute_features(submissions, workers)

    if workers <= 1 or len(pairs) <= 1:
        for a, b in pairs:
            rows.append(compute_pair(a, b, manual_evidence))
    else:
        submissions_by_id = {str(s["workAnswerId"]): s for s in submissions}
        tasks = [(str(a["workAnswerId"]), str(b["workAnswerId"])) for a, b in pairs]
        completed = 0
        with ProcessPoolExecutor(
            max_workers=workers,
            initializer=init_worker,
            initargs=(
                str(RUN_DIR),
                MAX_COMPARE_IMAGES,
                str(FEATURE_CACHE_DIR),
                USE_FEATURE_CACHE,
                False,
                submissions_by_id,
                manual_evidence,
                common_object_ids,
                common_sha256,
                common_evidence_tokens,
            ),
        ) as executor:
            futures = [executor.submit(compute_pair_by_id, task) for task in tasks]
            for future in as_completed(futures):
                rows.append(future.result())
                completed += 1
        print(f"matched pairs: {completed}")

    rows.sort(key=lambda r: ({"confirmed": 0, "suspected": 1, "ignore": 2}[r["verdict"]], -r["evidenceSimilarity"], -r["siftInliers"]))
    out_json = RUN_DIR / "advanced_similarity.json"
    out_csv = RUN_DIR / "advanced_similarity.csv"
    out_json.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    with out_csv.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0].keys()) if rows else [])
        if rows:
            writer.writeheader()
            writer.writerows(rows)
    print(f"wrote {out_csv}")
    confirmed_count = sum(1 for r in rows if r["verdict"] == "confirmed")
    suspected_count = sum(1 for r in rows if r["verdict"] == "suspected")
    ignore_count = sum(1 for r in rows if r["verdict"] == "ignore")
    print(f"verdict counts: confirmed={confirmed_count}, suspected={suspected_count}, ignore={ignore_count}")
    print_limit = int(os.environ.get("ADVANCED_SIMILARITY_PRINT_LIMIT", "80"))
    printed = 0
    for r in rows:
        if r["verdict"] != "ignore" and printed < print_limit:
            print(r["verdict"], r["aName"], "vs", r["bName"], "sift", r["siftInliers"], r["siftRatio"], "akaze", r["akazeInliers"], r["akazeRatio"], "ev", r["evidenceSimilarity"])
            printed += 1
    remaining = confirmed_count + suspected_count - printed
    if remaining > 0:
        print(f"... {remaining} non-ignore pairs omitted from console; see {out_csv}")


if __name__ == "__main__":
    main()
