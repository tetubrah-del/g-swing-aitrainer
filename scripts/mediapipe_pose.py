#!/usr/bin/env python3
import base64
import json
import sys
from io import BytesIO

import mediapipe as mp
import numpy as np
from PIL import Image

LANDMARK_INDEX = {
    "leftShoulder": 11,
    "rightShoulder": 12,
    "leftElbow": 13,
    "rightElbow": 14,
    "leftWrist": 15,
    "rightWrist": 16,
    "leftHip": 23,
    "rightHip": 24,
    "leftKnee": 25,
    "rightKnee": 26,
    "leftAnkle": 27,
    "rightAnkle": 28,
}


def clamp01(value):
    if value is None:
        return None
    if value < 0:
        return 0.0
    if value > 1:
        return 1.0
    return float(value)


def decode_image(base64_image):
    data = base64.b64decode(base64_image)
    image = Image.open(BytesIO(data)).convert("RGB")
    return np.array(image)


def extract_pose(pose_landmarks):
    out = {}
    for name, idx in LANDMARK_INDEX.items():
        if not pose_landmarks or idx >= len(pose_landmarks):
            out[name] = None
            continue
        lm = pose_landmarks[idx]
        if lm is None:
            out[name] = None
            continue
        out[name] = {"x": clamp01(lm.x), "y": clamp01(lm.y)}
    return out


def main():
    payload = json.load(sys.stdin)
    frames = payload.get("frames") or []
    try:
        solutions = mp.solutions
    except AttributeError:
        from mediapipe.python import solutions as mp_solutions

        solutions = mp_solutions
    pose = solutions.pose.Pose(
        static_image_mode=True,
        model_complexity=2,
        min_detection_confidence=0.3,
        min_tracking_confidence=0.3,
    )
    out_frames = []
    for frame in frames:
        idx = frame.get("idx")
        base64_image = frame.get("base64Image")
        pose_landmarks = None
        if base64_image:
            image = decode_image(base64_image)
            result = pose.process(image)
            if result and result.pose_landmarks:
                pose_landmarks = result.pose_landmarks.landmark
        out_frames.append(
            {
                "idx": idx,
                "pose": extract_pose(pose_landmarks),
            }
        )
    print(json.dumps({"frames": out_frames}))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
