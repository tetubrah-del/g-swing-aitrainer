export type SwingPhaseKey = "address" | "top" | "downswing" | "impact" | "finish";

export interface ClientPhaseFrame {
  id: string;
  phase: SwingPhaseKey;
  base64Image: string; // JPEG base64 (no prefix)
  mimeType: string; // "image/jpeg"
  timestampSec: number; // video currentTime in seconds
}

export type ClientPhaseFrames = ClientPhaseFrame[];
