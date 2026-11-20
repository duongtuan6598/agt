// AGT job briefs: one structured file per job, built from the trade's form (agt-form/v1).
// The same code runs in the browser (/jobs), on the exam worker (/quotes, /requests) and inside the sealed box,
// so the client, the service and the AI all read a brief the same way. No dependencies.
//
// A brief (agt-brief/v1) is canonical JSON: keys sorted, no spaces. keccak256 of its UTF-8 bytes is the
// job's `spec` on chain — the brief IS the contract the result is judged against.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.AGTBrief = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const SCHEMA = "agt-brief/v1";

  function canonical(v) {
    if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
    if (v && typeof v === "object") return "{" + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
    return JSON.stringify(v);
  }

  const words = (t) => (String(t || "").match(/[\p{L}\p{N}]+(?:['’.-][\p{L}\p{N}]+)*/gu) || []).length;
  const str = (x) => typeof x === "string";

  // Check one value against its field; returns an error string or null.
  function checkField(f, v) {
    const empty = v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
    if (empty) return f.required ? `${f.label}: required` : null;
    switch (f.type) {
      case "text":
      case "longtext":
        if (!str(v)) return `${f.label}: must be text`;
        if (f.maxLength && v.length > f.maxLength) return `${f.label}: at most ${f.maxLength} characters`;
        if (f.maxWords && words(v) > f.maxWords) return `${f.label}: at most ${f.maxWords} words`;
        return null;
      case "select":
        return f.options.includes(v) ? null : `${f.label}: not one of the options`;
      case "number":
        if (typeof v !== "number" || !Number.isFinite(v)) return `${f.label}: must be a number`;
        if (f.min !== undefined && v < f.min) return `${f.label}: at least ${f.min}`;
        if (f.max !== undefined && v > f.max) return `${f.label}: at most ${f.max}`;
        return null;
      case "list":
        if (!Array.isArray(v) || !v.every((x) => str(x) && x.trim() && x.length <= 300)) return `${f.label}: a list of short texts`;
        return f.maxItems && v.length > f.maxItems ? `${f.label}: at most ${f.maxItems} items` : null;
      case "pairs":
        if (!Array.isArray(v) || !v.every((p) => Array.isArray(p) && p.length === 2 && p.every((x) => str(x) && x.trim() && x.length <= 300))) return `${f.label}: a list of pairs`;
        return f.maxItems && v.length > f.maxItems ? `${f.label}: at most ${f.maxItems} pairs` : null;
      default:
        return `${f.label}: unknown field type ${f.type}`;
    }
  }

  // Price and time guide from the form's pricing rule (deterministic: client, service and AI agree).
  function estimate(form, fields) {
    const p = form.pricing;
    const count = p.countIsNumber ? Number(fields[p.countField] || 0) : words(fields[p.countField]);
    const units = Math.max(1, Math.ceil(count / p.perUnit));
    return { count, units, priceHat: Math.max(p.minHat, units * p.hatPerUnit), days: Math.max(p.minDays, Math.ceil(units / p.unitsPerDay)) };
  }

  // Build a brief from the client's answers. `extra` = up to form.maxExtraCriteria acceptance criteria of the client.
  function build(form, fields, extra = [], quote = null) {
    const clean = {};
    for (const f of form.fields) {
      let v = fields[f.key];
      if (str(v)) v = v.trim();
      if (Array.isArray(v)) v = v.map((x) => (Array.isArray(x) ? x.map((y) => String(y).trim()) : String(x).trim())).filter((x) => (Array.isArray(x) ? x[0] && x[1] : x));
      if (f.type === "number" && str(v) && v !== "") v = Number(v);
      if (v !== undefined && v !== "" && !(Array.isArray(v) && !v.length)) clean[f.key] = v;
    }
    const b = {
      schema: SCHEMA,
      form: `${form.id}@${form.version}`,
      trade: form.trade,
      fields: clean,
      acceptance: [...form.acceptance, ...extra.map((x) => String(x).trim()).filter(Boolean)],
      deliverable: form.deliverable,
    };
    if (quote) b.quote = quote;
    return b;
  }

  // Validate a brief against its form. Returns { ok, errors }.
  function validate(form, b) {
    const errors = [];
    if (!b || b.schema !== SCHEMA) return { ok: false, errors: ["not an agt-brief/v1 file"] };
    if (b.form !== `${form.id}@${form.version}` || b.trade !== form.trade) errors.push("brief is for another form or trade");
    if (form.status !== "open") errors.push(`the ${form.title} trade is not open for jobs yet (no licence exam)`);
    const known = new Set(form.fields.map((f) => f.key));
    for (const k of Object.keys(b.fields || {})) if (!known.has(k)) errors.push(`unknown field ${k}`);
    for (const f of form.fields) {
      const e = checkField(f, (b.fields || {})[f.key]);
      if (e) errors.push(e);
    }
    const base = form.acceptance.length;
    if (!Array.isArray(b.acceptance) || b.acceptance.slice(0, base).join("\n") !== form.acceptance.join("\n")) errors.push("the trade's acceptance criteria must be included unchanged");
    else if (b.acceptance.length - base > form.maxExtraCriteria) errors.push(`at most ${form.maxExtraCriteria} extra criteria`);
    else if (b.acceptance.slice(base).some((x) => !str(x) || !x.trim() || x.length > 300)) errors.push("extra criteria must be short texts");
    if (canonical(b.deliverable) !== canonical(form.deliverable)) errors.push("deliverable must be the trade's");
    if (b.quote !== undefined) {
      const q = b.quote;
      if (!q || !str(q.id) || !Number.isInteger(q.priceHat) || q.priceHat <= 0 || !Number.isInteger(q.days) || q.days <= 0) errors.push("bad quote");
    }
    const extra = Object.keys(b).filter((k) => !["schema", "form", "trade", "fields", "acceptance", "deliverable", "quote"].includes(k));
    if (extra.length) errors.push(`unknown keys: ${extra.join(", ")}`);
    return { ok: errors.length === 0, errors };
  }

  // A readable rendering for the AI and for people (the JSON stays the source of truth).
  function render(form, b) {
    const lines = [`# ${form.title} job (${b.form})`, ""];
    for (const f of form.fields) {
      const v = b.fields[f.key];
      if (v === undefined) continue;
      const shown = f.type === "select" && f.optionLabels ? f.optionLabels[f.options.indexOf(v)] || v
        : f.type === "pairs" ? v.map(([a, c]) => `- ${a} → ${c}`).join("\n")
        : f.type === "list" ? v.map((x) => `- ${x}`).join("\n")
        : String(v);
      lines.push(`## ${f.label}`, shown, "");
    }
    lines.push("## Acceptance criteria (the result is judged against these, and only these)", ...b.acceptance.map((a, i) => `${i + 1}. ${a}`), "");
    lines.push("## Deliverable", b.deliverable.description);
    if (b.quote) lines.push("", `## Agreed`, `Price ${b.quote.priceHat} Hat, ${b.quote.days} day(s).`);
    return lines.join("\n");
  }

  const parse = (text) => { try { return JSON.parse(text); } catch { return null; } };

  return { SCHEMA, canonical, words, estimate, build, validate, render, parse };
});
