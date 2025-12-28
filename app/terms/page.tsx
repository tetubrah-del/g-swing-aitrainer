import Link from "next/link";

export const metadata = {
  title: "利用規約",
};

export default function TermsPage() {
  return (
    <main className="min-h-screen bg-gradient-to-b from-slate-950 via-slate-900 to-slate-950 text-slate-50 px-4 py-10">
      <div className="mx-auto w-full max-w-3xl space-y-6">
        <header className="space-y-3">
          <h1 className="text-2xl sm:text-3xl font-semibold">利用規約</h1>
          <p className="text-sm text-slate-300">
            本利用規約（以下「本規約」といいます。）は、Core Logic Studio（以下「当社」といいます。）が提供するゴルフAIスイング診断サービス（以下「本サービス」といいます。）の利用条件を定めるものです。ユーザーは、本規約に同意したうえで本サービスを利用するものとします。
          </p>
          <p className="text-xs text-slate-400">
            <Link href="/golf/register" className="text-emerald-300 underline underline-offset-4">
              登録画面へ戻る
            </Link>
          </p>
        </header>

        <section className="rounded-2xl border border-slate-800 bg-slate-900/80 shadow-2xl shadow-emerald-900/20 p-6 sm:p-8 space-y-6">
          <Article title="第1条（適用）">
            <ol className="list-decimal pl-5 space-y-2 text-sm text-slate-200">
              <li>本規約は、本サービスの利用に関する当社とユーザーとの間の一切の関係に適用されます。</li>
              <li>当社が本サービス上で別途定めるルール、ガイドライン等は、本規約の一部を構成するものとします。</li>
            </ol>
          </Article>

          <Article title="第2条（定義）">
            <p className="text-sm text-slate-200">本規約において、以下の用語はそれぞれ以下の意味を有します。</p>
            <ol className="list-decimal pl-5 space-y-2 text-sm text-slate-200">
              <li>「ユーザー」とは、本規約に同意のうえ本サービスを利用するすべての者をいいます。</li>
              <li>
                「診断結果」とは、ユーザーがアップロードした画像または動画等をもとに、本サービスがAIを用いて生成する分析結果、スコア、コメント、提案等をいいます。
              </li>
              <li>「投稿データ」とは、ユーザーが本サービスにアップロードまたは送信する画像、動画、テキストその他一切のデータをいいます。</li>
            </ol>
          </Article>

          <Article title="第3条（サービス内容）">
            <ol className="list-decimal pl-5 space-y-2 text-sm text-slate-200">
              <li>本サービスは、ユーザーがアップロードしたゴルフスイングに関する画像または動画等をもとに、AIによる自動解析を行い、参考情報としての診断結果を提供するサービスです。</li>
              <li>本サービスは、ゴルフ上達を保証するものではありません。</li>
              <li>当社は、本サービスの内容について、その正確性、完全性、有用性、特定目的への適合性を保証するものではありません。</li>
            </ol>
          </Article>

          <Article title="第4条（利用条件・禁止事項）">
            <p className="text-sm text-slate-200">ユーザーは、本サービスの利用にあたり、以下の行為を行ってはなりません。</p>
            <ol className="list-decimal pl-5 space-y-2 text-sm text-slate-200">
              <li>法令または公序良俗に違反する行為</li>
              <li>他人の権利（著作権、肖像権、プライバシー権等）を侵害する行為</li>
              <li>虚偽または第三者になりすます行為</li>
              <li>本サービスの運営を妨害する行為</li>
              <li>その他、当社が不適切と判断する行為</li>
            </ol>
          </Article>

          <Article title="第5条（AI診断に関する注意事項）">
            <ol className="list-decimal pl-5 space-y-2 text-sm text-slate-200">
              <li>
                本サービスにおける診断結果は、ゴルフスイングに関する
                <strong className="font-semibold text-slate-100">参考情報および娯楽的要素を含む情報提供</strong>
                を目的とするものであり、専門的な指導、助言、診断を行うものではありません。
              </li>
              <li>
                本サービスは、プロゴルファー、ゴルフインストラクター、医師、理学療法士、トレーナー等による個別指導または医療行為、リハビリ行為の代替となるものではありません。
              </li>
              <li>
                診断結果は、撮影条件、環境、個人差、AIの特性等により変動する可能性があり、その内容の正確性や再現性を保証するものではありません。
              </li>
              <li>
                ユーザーは、診断結果を自己の判断と責任において参考として利用するものとし、身体的違和感や痛みが生じた場合には、本サービスの利用を直ちに中止するものとします。
              </li>
            </ol>
          </Article>

          <Article title="第6条（免責事項）">
            <ol className="list-decimal pl-5 space-y-2 text-sm text-slate-200">
              <li>当社は、診断結果の内容、正確性、完全性、有用性、効果について一切の責任を負いません。</li>
              <li>
                ユーザーが本サービスまたは診断結果を利用したことにより生じた、スコアの悪化、上達しなかったこと、期待した効果が得られなかったこと等について、当社は責任を負いません。
              </li>
              <li>
                本サービスの利用または診断結果をもとに行った練習、プレー等に起因する、怪我、体調不良、身体的損害、既存の疾患の悪化等について、当社は一切の責任を負いません。
              </li>
              <li>
                当社は、本サービスに関連して発生したデータの消失、破損、解析エラー、通信障害、サーバーダウン、外部サービス（AI API、クラウドサービス等）の不具合について責任を負いません。
              </li>
              <li>
                当社は、本サービスに関連してユーザーに生じた間接損害、逸失利益、機会損失、精神的損害について、一切の責任を負いません。
              </li>
              <li>
                当社の責任が法令上否定されない場合であっても、当社の賠償責任は、当社に故意または重過失がある場合を除き、当該ユーザーが当社に支払った直近1か月分の利用料金を上限とします。
              </li>
            </ol>
          </Article>

          <Article title="第7条（知的財産権）">
            <ol className="list-decimal pl-5 space-y-2 text-sm text-slate-200">
              <li>
                本サービスおよび本サービスに関連するプログラム、デザイン、文章、画像等の著作権その他の知的財産権は、当社または正当な権利者に帰属します。
              </li>
              <li>ユーザーは、本サービスを利用することにより、これらの権利を侵害してはなりません。</li>
            </ol>
          </Article>

          <Article title="第8条（ユーザー投稿データの取扱い）">
            <ol className="list-decimal pl-5 space-y-2 text-sm text-slate-200">
              <li>投稿データの著作権は、ユーザーまたは正当な権利者に帰属します。</li>
              <li>
                ユーザーは、当社に対し、本サービスの提供、品質改善、保守、運営に必要な範囲で、投稿データを無償で利用（複製、解析等を含む）する権利を許諾するものとします。
              </li>
              <li>当社は、ユーザーの明示的な同意なく、投稿データを第三者に公開またはマーケティング目的で利用しません。</li>
            </ol>
          </Article>

          <Article title="第9条（サービスの変更・停止）">
            <p className="text-sm text-slate-200">
              当社は、ユーザーへの事前通知なく、本サービスの内容を変更、中断、または終了することができるものとします。
            </p>
          </Article>

          <Article title="第10条（利用制限・停止）">
            <p className="text-sm text-slate-200">
              当社は、ユーザーが本規約に違反した場合、事前通知なく本サービスの全部または一部の利用を制限または停止することができます。
            </p>
          </Article>

          <Article title="第11条（個人情報の取扱い）">
            <p className="text-sm text-slate-200">
              当社は、ユーザーの個人情報を、別途定めるプライバシーポリシーに従い、適切に取り扱います。
            </p>
          </Article>

          <Article title="第12条（規約の変更）">
            <p className="text-sm text-slate-200">
              当社は、必要と判断した場合には、ユーザーへの通知なく本規約を変更することができます。変更後の規約は、本サービス上に表示された時点から効力を生じるものとします。
            </p>
          </Article>

          <Article title="第13条（準拠法・管轄）">
            <ol className="list-decimal pl-5 space-y-2 text-sm text-slate-200">
              <li>本規約は、日本法を準拠法とします。</li>
              <li>
                本サービスに関して当社とユーザーとの間で生じた紛争については、当社の所在地を管轄する地方裁判所を専属的合意管轄裁判所とします。
              </li>
            </ol>
          </Article>

          <div className="pt-2 text-sm text-slate-200 space-y-1">
            <p>【制定日】2025年12月31日</p>
            <p>【運営者】Core Logic Studio</p>
          </div>
        </section>
      </div>
    </main>
  );
}

function Article(props: { title: string; children: React.ReactNode }) {
  return (
    <article className="space-y-2">
      <h2 className="text-lg font-semibold">{props.title}</h2>
      {props.children}
    </article>
  );
}

