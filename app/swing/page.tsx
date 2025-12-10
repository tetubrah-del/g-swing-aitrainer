import SwingForm from "./SwingForm";
import SwingAnalyzerClient from "./SwingAnalyzerClient";

// 🔥 Server Component（フォームは Server 側で保持）
export default function Page() {
  return (
    <div className="mx-auto flex min-h-screen max-w-5xl flex-col gap-8 px-6 py-12">
      <header className="space-y-2">
        <h1 className="text-3xl font-bold">Swing Analyzer (Vision JSON)</h1>
        <p className="text-sm text-gray-600">
          動画をアップロードすると、代表フレームを抽出し Vision API で JSON を生成します。
        </p>
      </header>

      <SwingForm />
      <SwingAnalyzerClient />
    </div>
  );
}
