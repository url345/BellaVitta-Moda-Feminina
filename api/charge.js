import QRCode from "qrcode";
import { PRODUCTS, COUPONS, FRETE } from "./_products.js";

const BASE = process.env.ANOVAPAY_URL || "https://api.anovapay.com.br";
const dg = (s) => String(s || "").replace(/\D/g, "");

function cpfOk(c) {
  c = dg(c);
  if (c.length !== 11 || /^(\d)\1+$/.test(c)) return false;
  for (let t = 9; t < 11; t++) {
    let s = 0;
    for (let i = 0; i < t; i++) s += c[i] * (t + 1 - i);
    if (((s * 10) % 11) % 10 != c[t]) return false;
  }
  return true;
}

// Todo Pix "copia e cola" (BR Code) começa com 000201: procuramos na resposta do gateway.
function findBrCode(o) {
  if (typeof o === "string") return o.startsWith("000201") ? o : null;
  if (o && typeof o === "object") {
    for (const v of Object.values(o)) {
      const r = findBrCode(v);
      if (r) return r;
    }
  }
  return null;
}
const findId = (o) => o?.id ?? o?.data?.id ?? o?.charge?.id ?? o?.txid ?? null;

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ erro: "Método não permitido." });

  const ci = process.env.ANOVAPAY_CLIENT_ID;
  const cs = process.env.ANOVAPAY_CLIENT_SECRET;
  const unit = process.env.AMOUNT_UNIT || "reais";
  if (!ci || !cs) return res.status(500).json({ erro: "Pix ainda não configurado no servidor." });
  if (unit !== "reais" && unit !== "centavos")
    return res.status(500).json({ erro: "Configure AMOUNT_UNIT como reais ou centavos." });

  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch { b = null; } }
  if (!b || typeof b !== "object") return res.status(400).json({ erro: "Pedido inválido." });

  // Valida os dados do comprador e do endereço no servidor (não confiar no navegador)
  const c = b.cliente || {}, e = b.endereco || {};
  if (String(c.nome || "").trim().split(/\s+/).length < 2) return res.status(400).json({ erro: "Informe nome e sobrenome." });
  if (!cpfOk(c.cpf)) return res.status(400).json({ erro: "CPF inválido." });
  if (dg(c.tel).length !== 11) return res.status(400).json({ erro: "Celular inválido." });
  if (c.email && !/^\S+@\S+\.\S+$/.test(c.email)) return res.status(400).json({ erro: "E-mail inválido." });
  if (dg(e.cep).length !== 8 || !e.rua || !e.num || !e.bai || !e.cid || !/^[A-Za-z]{2}$/.test(e.uf || ""))
    return res.status(400).json({ erro: "Endereço incompleto." });

  // Recalcula o total com os preços do SERVIDOR
  const items = Array.isArray(b.items) ? b.items : [];
  if (!items.length || items.length > 30) return res.status(400).json({ erro: "Carrinho vazio." });
  let sub = 0;
  for (const it of items) {
    const p = PRODUCTS.find((x) => x.id === Number(it.id));
    const q = Math.floor(Number(it.q));
    if (!p || p.price == null) return res.status(400).json({ erro: "Produto indisponível." });
    if (!(q >= 1 && q <= 50)) return res.status(400).json({ erro: "Quantidade inválida." });
    if (p.estoque != null && q > p.estoque) return res.status(400).json({ erro: "Estoque insuficiente." });
    const preco = p.promo && p.promo < p.price ? p.promo : p.price;
    sub += Math.round(preco * 100) * q;
  }
  const cup = COUPONS[String(b.cupom || "").toUpperCase()];
  const desconto = cup ? Math.round((sub * cup.pct) / 100) : 0;
  const totalCent = sub - desconto + Math.round(FRETE * 100);
  const amount = unit === "centavos" ? totalCent : totalCent / 100;

  const ref = Math.random().toString(36).slice(2, 8).toUpperCase();
  try {
    const r = await fetch(`${BASE}/charges`, {
      method: "POST",
      headers: { ci, cs, "Content-Type": "application/json" },
      body: JSON.stringify({ amount, description: `Pedido #${ref}` }),
    });
    const txt = await r.text();
    let data;
    try { data = JSON.parse(txt); } catch { data = { raw: txt }; }
    if (!r.ok) {
      console.error("AnovaPay recusou", r.status, txt.slice(0, 500));
      return res.status(502).json({ erro: "O gateway recusou a cobrança." });
    }
    const brCode = findBrCode(data);
    if (!brCode) console.error("Resposta sem BR Code:", txt.slice(0, 800));
    const qr = brCode ? await QRCode.toDataURL(brCode, { margin: 1, width: 320 }) : null;
    return res.status(200).json({ ok: true, ref, chargeId: findId(data), total: totalCent / 100, brCode, qr });
  } catch (err) {
    console.error("Erro ao falar com o gateway", err);
    return res.status(502).json({ erro: "Não foi possível falar com o gateway." });
  }
}
