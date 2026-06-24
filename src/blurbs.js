'use strict';
// LLM generation of client-facing progress blurbs for the weekly Client Updates
// report. Each call turns the signals gathered for one task (ClickUp description,
// comments, synced Jira fields, live Jira status/comments) into:
//   - blurb:         1–3 sentences, client-safe, sent in the email
//   - internalNote:  PM-only note (never emailed) flagging who we're waiting on
//   - needsAttention: true if the task looks stuck / needs PM action this week
//
// The system prompt is the core IP: it enforces that nothing internal (dev talk,
// disagreements, pushback, jargon, tooling names, costs, staff names) ever leaks
// into the client-facing blurb. The draft → human-approve gate in the UI is the
// second line of defence.
//
// Degrades gracefully: if no API key is configured or the call fails, returns a
// safe placeholder with needsAttention=true so the PM writes the blurb manually.

const Anthropic = require('@anthropic-ai/sdk');

// Per-task volume (hundreds of tasks/week) → default to Sonnet for cost; override
// with BLURB_MODEL (e.g. claude-opus-4-8) when more nuance is wanted.
const MODEL = process.env.BLURB_MODEL || 'claude-sonnet-4-6';

let _client = null;
function client() {
  if (!_client) _client = new Anthropic(); // reads ANTHROPIC_API_KEY from env
  return _client;
}

// Static — kept first and cached so repeated per-task calls only pay for it once.
const SYSTEM_PROMPT = `You write short, client-facing weekly progress updates for a UK digital agency's retainer clients. Each update covers ONE piece of early-stage work (scoping, quoting, or discovery — before it reaches the build team). The agency's project managers send these out every Monday to get ahead of clients chasing for status.

Your job: from the information provided about a task, write a brief, honest, reassuring update describing what is genuinely happening at this stage — where the work sits, whether the ball is with us or with the client, and a rough sense of the next step or timeframe.

Return a JSON object with exactly these fields:
- "blurb": the client-facing update. 1–3 sentences, plain English, UK spelling. Refer to the agency as "we"/"our team" and to the client as "you". No greeting, no sign-off, no emoji.
- "internalNote": a single private line for the project manager ONLY. This is NEVER shown to the client. Be blunt and specific: who the task is waiting on, roughly how long it has been sitting, and anything the PM should chase this week. If nothing is needed, say so briefly.
- "needsAttention": boolean. true if the task looks stuck, has been waiting on the client or on us for a while, or otherwise needs the PM to act this week; otherwise false.

HARD RULES for the "blurb" (these protect the client relationship — never break them):
- NEVER reveal internal or behind-the-scenes discussion: developer/technical chatter, internal debate, disagreement, push-back, blame, uncertainty between team members, or anything said "internally".
- NEVER name individual internal staff, and NEVER name internal tools or process mechanics (e.g. Jira, ClickUp, sprints, pods, tickets, boards). Speak about "our team" generically.
- NEVER mention hours, quotes, day rates, costs, or budget figures unless the input shows they have ALREADY been formally shared with the client.
- NEVER imply the task has stalled, been forgotten, sat untouched, or slipped. Frame any wait positively and constructively.
- If the task is genuinely waiting on the client, phrase it as a gentle, polite prompt for their input or a decision — not as a complaint.
- Do NOT invent facts, dates, or commitments that the input does not support. If detail is thin, keep the blurb general but still warm and forward-looking ("our team is working through the detail and will share next steps shortly").
- Keep it specific to THIS task where the input allows, so it never reads like a generic template.

Output ONLY the JSON object.`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    blurb:         { type: 'string' },
    internalNote:  { type: 'string' },
    needsAttention:{ type: 'boolean' },
  },
  required: ['blurb', 'internalNote', 'needsAttention'],
};

// signals — object describing one task. All fields optional; we render what's present.
//   { name, status, statusAgeDays, description, clickupComments:[{author,isInternal,text,date}],
//     jiraStatus, sprint, quoteHours, discoveryHours, jiraLive:{status,statusCategory},
//     jiraComments:[{author,text,date}] }
function renderSignals(s) {
  const lines = [];
  if (s.name)          lines.push(`Task: ${s.name}`);
  if (s.status)        lines.push(`Current stage: ${s.status}`);
  if (s.statusAgeDays != null) lines.push(`Days since last activity: ${s.statusAgeDays}`);
  if (s.jiraStatus)    lines.push(`Internal delivery status: ${s.jiraStatus}`);
  if (s.jiraLive && s.jiraLive.status) lines.push(`Live delivery status: ${s.jiraLive.status}${s.jiraLive.statusCategory ? ' (' + s.jiraLive.statusCategory + ')' : ''}`);
  if (s.sprint)        lines.push(`Scheduled window: ${s.sprint}`);
  if (s.quoteHours != null)     lines.push(`Quote (hours, internal): ${s.quoteHours}`);
  if (s.discoveryHours != null) lines.push(`Discovery (hours, internal): ${s.discoveryHours}`);
  if (s.description)   lines.push(`\nDescription:\n${String(s.description).slice(0, 2000)}`);

  const cu = (s.clickupComments || []).slice(0, 12);
  if (cu.length) {
    lines.push('\nComments (most recent last) — internal vs client noted:');
    cu.forEach(c => {
      const who = c.isInternal ? 'INTERNAL' : 'client';
      lines.push(`- [${who}] ${c.author || '?'}: ${String(c.text || '').replace(/\s+/g, ' ').slice(0, 400)}`);
    });
  }

  const jc = (s.jiraComments || []).slice(0, 6);
  if (jc.length) {
    lines.push('\nDelivery-side notes (internal — for your context only, treat as sensitive):');
    jc.forEach(c => {
      lines.push(`- ${c.author || '?'}: ${String(c.text || '').replace(/\s+/g, ' ').slice(0, 400)}`);
    });
  }

  return lines.join('\n');
}

async function generateBlurb(signals) {
  const fallback = {
    blurb: '',
    internalNote: 'Auto-update unavailable — please write this manually.',
    needsAttention: true,
  };
  if (!process.env.ANTHROPIC_API_KEY) {
    fallback.internalNote = 'ANTHROPIC_API_KEY not configured — blurb generation skipped.';
    return fallback;
  }

  try {
    const resp = await client().messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: [
        { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
      ],
      output_config: { format: { type: 'json_schema', schema: SCHEMA } },
      messages: [
        { role: 'user', content: 'Write the weekly update for this task:\n\n' + renderSignals(signals) },
      ],
    });

    if (resp.stop_reason === 'refusal') {
      fallback.internalNote = 'Blurb generation was declined for this task — please write it manually.';
      return fallback;
    }

    const textBlock = (resp.content || []).find(b => b.type === 'text');
    if (!textBlock) return fallback;
    const parsed = JSON.parse(textBlock.text);
    return {
      blurb:          typeof parsed.blurb === 'string' ? parsed.blurb.trim() : '',
      internalNote:   typeof parsed.internalNote === 'string' ? parsed.internalNote.trim() : '',
      needsAttention: !!parsed.needsAttention,
    };
  } catch (e) {
    console.error('Blurb generation error:', e.message);
    fallback.internalNote = 'Blurb generation failed (' + e.message + ') — please write this manually.';
    return fallback;
  }
}

module.exports = { generateBlurb };
