# BANJEE WhatsApp Flows (PIN popup)

The **Choose** sheet (To bank / To BANJEE) is a WhatsApp _list_ message — not a Flow.

**PIN popups** need a Meta **Flow** with `input-type: passcode` so the PIN never appears in chat.

## Transfer / bank-send PIN (`zylo-pin-confirm.json`)

1. Meta Business Suite → WhatsApp Manager → your number → **Flows**
2. Create Flow → paste / import [`zylo-pin-confirm.json`](./zylo-pin-confirm.json)
3. **Publish** (or keep Draft and set `WA_RAMP_FLOW_MODE=draft` for your own number only)
4. Copy the Flow **ID** (digits only)
5. Railway / `.env`:

```bash
WA_RAMP_PIN_FLOW_ENABLED=true
WA_RAMP_PIN_FLOW_ID=123456789012345
# Only while testing an unpublished draft:
# WA_RAMP_FLOW_MODE=draft
```

6. Redeploy

Until Meta verifies your account, **leave `WA_RAMP_PIN_FLOW_ENABLED` unset** — users type the 4-digit PIN in chat.

With both vars set, USDC/XLM transfer and bank send show **Enter PIN** → popup passcode.

## Onboarding (`zylo-onboard.json`)

Same idea for signup:

```bash
WA_RAMP_ONBOARD_FLOW_ID=...
```
