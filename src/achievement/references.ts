import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export type ReferenceKind = "resource" | "achievement" | "attachment" | "cursor" | "worker";
export class ReferenceError extends Error {
  readonly code = "INVALID_REFERENCE";
  constructor() { super("참조가 유효하지 않거나 만료되었습니다. 다시 검색하여 발급받으세요."); }
}
/** Stateless signed references survive process restarts. No URL or path is accepted from a caller. */
export class ReferenceCodec {
  constructor(private readonly secret:string, private readonly now:()=>number = Date.now, private readonly ttlMs=15*60_000) {
    if (Buffer.byteLength(secret) < 32) throw new Error("EDUNET_REFERENCE_SECRET must contain at least 32 bytes");
  }
  issue(kind:ReferenceKind, data:Record<string,unknown>, ttlMs=this.ttlMs):string {
    const now=this.now();
    const body = Buffer.from(JSON.stringify({v:1,kind,aud:"edunet-achievement",iat:now,exp:now+Math.min(ttlMs, this.ttlMs),nonce:randomBytes(12).toString("base64url"),data})).toString("base64url");
    const token=`${body}.${this.sign(body)}`;
    if(token.length>16000) throw new ReferenceError();
    return token;
  }
  verify(token:string, kind:ReferenceKind):Record<string,unknown> {
    try {
      if (token.length > 16000 || !/^[\w-]+\.[\w-]+$/.test(token)) throw new ReferenceError();
      const [body,signature] = token.split(".");
      if (!body || !signature) throw new ReferenceError();
      const supplied = Buffer.from(signature,"base64url"), expected=Buffer.from(this.sign(body),"base64url");
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new ReferenceError();
      const value = JSON.parse(Buffer.from(body,"base64url").toString("utf8"));
      const now=this.now();
      if (value.v !== 1 || value.kind !== kind || value.aud !== "edunet-achievement" || !Number.isFinite(value.iat) || !Number.isFinite(value.exp) || value.iat > now+1000 || value.exp <= now || value.exp-value.iat > this.ttlMs || value.exp <= value.iat || !value.data || typeof value.data !== "object" || Array.isArray(value.data)) throw new ReferenceError();
      return value.data as Record<string,unknown>;
    } catch { throw new ReferenceError(); }
  }
  private sign(body:string):string { return createHmac("sha256",this.secret).update(body).digest("base64url"); }
}
