import nodemailer from "nodemailer";

const getSmtpConfig = () => {
  const host = process.env.SMTP_HOST ?? "";
  const port = Number(process.env.SMTP_PORT ?? "0");
  const user = process.env.SMTP_USER ?? "";
  const pass = process.env.SMTP_PASS ?? "";
  const from = process.env.SMTP_FROM ?? "";
  const secureEnv = process.env.SMTP_SECURE;
  const secure = secureEnv ? secureEnv === "true" : port === 465;

  const configured = !!host && !!port && !!user && !!pass && !!from;
  return { configured, host, port, user, pass, from, secure };
};

export async function sendVerificationEmail(params: { to: string; verifyUrl: string; expiresAt: number }) {
  const smtp = getSmtpConfig();
  const expiresMin = Math.max(1, Math.round((params.expiresAt - Date.now()) / 1000 / 60));

  const subject = "【Golf AI Trainer】メールアドレス確認のお願い";
  const text = `以下のリンクをクリックして、メールアドレス登録を完了してください。\n\n${params.verifyUrl}\n\n有効期限: 約${expiresMin}分\n\nこのメールに心当たりがない場合は破棄してください。`;

  if (!smtp.configured) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("SMTP not configured");
    }
    console.log("[email] Verification link:", params.verifyUrl);
    return { delivered: false as const };
  }

  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: { user: smtp.user, pass: smtp.pass },
  });

  await transporter.sendMail({
    from: smtp.from,
    to: params.to,
    subject,
    text,
  });

  return { delivered: true as const };
}

