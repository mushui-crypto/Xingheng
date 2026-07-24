import { QrCode } from "lucide-react";
import { useEffect, useState } from "react";

export type QrCodeDataUrlGenerator = (
  value: string,
  options: { errorCorrectionLevel: "M"; margin: number; width: number },
) => Promise<string>;

export function TotpQrCode({
  generateDataUrl,
  value,
}: {
  generateDataUrl?: QrCodeDataUrlGenerator;
  value: string;
}) {
  const [dataUrl, setDataUrl] = useState("");
  const [failed, setFailed] = useState(!generateDataUrl);

  useEffect(() => {
    let active = true;
    setDataUrl("");
    setFailed(false);
    if (!generateDataUrl || !value) {
      setFailed(true);
      return () => { active = false; };
    }
    void generateDataUrl(value, { errorCorrectionLevel: "M", margin: 2, width: 224 })
      .then((result) => {
        if (!active) return;
        if (!result.startsWith("data:image/")) {
          setFailed(true);
          return;
        }
        setDataUrl(result);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
      setDataUrl("");
    };
  }, [generateDataUrl, value]);

  if (dataUrl) {
    return (
      <div className="flex min-h-[248px] items-center justify-center bg-white p-3">
        <img
          alt="身份验证器二维码"
          className="h-56 w-56 max-w-full object-contain"
          height={224}
          src={dataUrl}
          width={224}
        />
      </div>
    );
  }

  return (
    <div
      className="flex min-h-[248px] flex-col items-center justify-center border border-white/15 bg-black px-5 text-center"
      role={failed ? "status" : undefined}
    >
      <QrCode className="text-muted" size={28} />
      <p className="mt-3 text-sm font-medium text-white">
        {failed ? "二维码暂不可用" : "正在生成二维码"}
      </p>
      {failed ? (
        <p className="mt-2 max-w-xs text-xs leading-5 text-muted">
          请使用下方手动设置值添加身份验证器。二维码不会通过外部服务生成。
        </p>
      ) : null}
    </div>
  );
}
