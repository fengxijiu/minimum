# ask_choice Format Rules

When calling `ask_choice`, every field has a hard character limit enforced at the tool layer.
Exceeding the limit returns an error and forces a rewrite. Follow these rules on the first attempt.

## question (≤ 100 chars)

State the **decision point only**. No context, no background, no tradeoff explanation.

```
BAD  "Given that the user wants to implement image upload and we need to decide between
      approach A which uses multer with disk storage and approach B which uses S3 presigned
      URLs, which strategy should we take?"

GOOD "Which upload strategy?"
```

Pattern: `"Which <noun>?"` or `"<Verb> <noun> — which way?"`

## title (≤ 50 chars)

Name the option. 2–5 words. No sentence.

```
BAD  "Use multer with disk storage and integrate with existing express middleware"
GOOD "multer + disk"
```

## summary (≤ 80 chars)

One short phrase. Trade-off hint only. No sentences, no "this approach does X".

```
BAD  "This option uses multer configured with memory limits and MIME validation, integrating
      with the existing router and requiring no new infrastructure dependencies."
GOOD "zero infra, local disk only"
```

## When to call ask_choice

Call only when the decision genuinely changes implementation direction, scope, or risk,
and no option is clearly best from available evidence.

Do NOT call for:
- decisions with an obvious best path
- confirmation of routine next steps
- choices that can be inferred from repo conventions
