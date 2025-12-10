// 🔥 Server Component（Server Actions を直接 action に bind）
import { analyzeVideo } from "../actions/analyzeVideo";

export default function SwingForm() {
  return (
    <form
      action={analyzeVideo}
      encType="multipart/form-data"
      className="flex flex-col gap-4 rounded-lg border p-4"
    >
      <label className="flex flex-col gap-2 text-sm font-medium text-gray-800">
        アップロードする動画
        <input
          type="file"
          name="video"
          accept="video/*"
          required
          className="rounded border px-3 py-2"
        />
      </label>

      <button
        type="submit"
        className="inline-flex items-center justify-center rounded bg-blue-600 px-4 py-2 text-sm font-semibold text-white"
      >
        動画を解析する（Server Action）
      </button>
    </form>
  );
}
