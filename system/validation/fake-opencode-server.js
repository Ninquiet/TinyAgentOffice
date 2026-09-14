'use strict';

// A fake OpenCode server, in process, speaking only what this app consumes.
//
// ---------------------------------------------------------------------------
// THIS IS A GUESS, NOT A COPY. Read this before trusting a green scenario.
// ---------------------------------------------------------------------------
//
// Every response and every event sequence here was built from the OpenAPI
// document and development event captures. The fake is intentionally broader
// than any single captured turn, so it remains a model rather than a replay.
//
// That matters more than it sounds, because the schema has already misled us
// three times:
//
//   - `rate_limited` is in no event list; rate limiting arrives as
//     session.status {type:"retry"} and as session.error with an APIError.
//   - GET /session/status is documented as a map of every session's state and
//     returns {} against a server with 72 live sessions.
//   - Whether one turn emits several session.next.step.ended is still unknown,
//     and the state machine had to be designed to be correct either way.
//
// So the risk is precise: if the real event ORDER differs from what these
// scenes emit, the suite is proving a convincing fiction. It is the same
// failure as a test double that disagrees with production, except at the scale
// of the whole system rather than one module.
//
// It has already paid for itself -- it found two real bugs on its first run,
// the dead prompt caps and the unreported stream loss -- and that is an
// argument for keeping it, not for believing it.
//
// Compare this model with fresh real event captures whenever the supported
// OpenCode version changes. Event order, gaps, and the families emitted by a
// single turn are all part of the integration contract.
//
// CORRECTED 2026-08-20. The plan above used to end "where they differ, the
// recording wins". That is only half right, and the half that is wrong is
// dangerous.
//
// A recording is a SAMPLE, not an inventory. Two real runs of the same build
// emitted different event families: pass1-neon-hammer contains 19 distinct
// types and not one `session.next.*` among them, while a run on TestApp3
// produced a `session.next.prompt.admitted` -- the ledger's admitted_at is
// written from that event and nothing else, and it is set on that row.
//
// So the rule is directional:
//
//   - On what a recording DOES contain, it beats the schema. Observed order,
//     observed payload shapes, observed repetition.
//   - On what it does NOT contain, it says nothing at all. Absence from one
//     recording is not evidence the event does not exist, and building on
//     that reading is how a check gets written against a false premise.
//
// This was nearly made concrete: a proposed validator would have compared the
// reducer's handled cases against the recording and flagged 19 of 26 as dead
// code. Existence questions go to the OpenAPI document; behaviour questions go
// to the recordings.
//
// It exists because the whole orchestration -- advanceWorld's thirteen phases,
// the daemon's runOnce -- had no test at all. Every bug in this refactor lived
// in the wiring between parts, and wiring is precisely what a mock inside the
// system cannot exercise. So the fake sits at the edge: everything inboard of
// the HTTP boundary is the real code.
//
// Deliberate fidelity choices, each one a thing that bit us:
//
// - GET /session/status returns {} always, because the real one does, verified
//   against a server with 72 live sessions. A fake that answered helpfully here
//   would hide the fact that nothing may depend on it.
// - Submitting a prompt appends it as a user message, because that is what the
//   delivery verification looks for. A fake that just returned 200 would let a
//   broken verification path pass.
// - Events are only emitted when a test asks. Nothing is inferred, so a test
//   that forgets to emit sees a session stuck in `unknown`, which is the honest
//   answer.

const http = require('http');

function jsonResponse(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (_) {
        resolve({ raw });
      }
    });
  });
}

async function createFakeOpencodeServer(options = {}) {
  const sessionId = options.sessionId || 'ses_fake';
  const sessionTitle = options.sessionTitle || 'Fake Agent Session';

  const state = {
    sessions: [{ id: sessionId, title: sessionTitle, time: { updated: Date.now() } }],
    messages: [],
    subscribers: new Set(),
    promptCalls: [],
    pendingPrompt: null,
    questions: [],
    permissions: [],
    eventLog: [],
  };

  let nextMessageId = 1;

  function addMessage({ role, text, completed = true, at = Date.now() }) {
    const message = {
      info: {
        id: `msg_${nextMessageId++}`,
        role,
        time: { created: at, ...(completed ? { completed: at } : {}) },
      },
      parts: [{ type: 'text', text }],
    };
    state.messages.push(message);
    state.sessions[0].time.updated = at;
    return message;
  }

  // Push an event to every open /event stream, in the envelope the real server
  // uses: {id, type, properties}.
  function emit(type, properties = {}) {
    const event = {
      id: `evt_${Math.random().toString(36).slice(2, 12)}`,
      type,
      properties: { sessionID: sessionId, ...properties },
    };
    state.eventLog.push(event);
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of state.subscribers) {
      try {
        res.write(frame);
      } catch (_) {
        state.subscribers.delete(res);
      }
    }
    return event;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const route = `${req.method} ${url.pathname}`;

    if (route === 'GET /global/health') return jsonResponse(res, 200, { healthy: true });

    if (route === 'GET /event') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify({ id: 'evt_connected', type: 'server.connected', properties: {} })}\n\n`);
      state.subscribers.add(res);
      req.on('close', () => state.subscribers.delete(res));
      return undefined;
    }

    if (route === 'GET /session') return jsonResponse(res, 200, state.sessions);

    // Matches reality: empty regardless of arguments. Nothing may depend on it.
    if (route === 'GET /session/status') return jsonResponse(res, 200, {});

    if (req.method === 'GET' && /^\/session\/[^/]+\/message$/.test(url.pathname)) {
      return jsonResponse(res, 200, state.messages);
    }

    if (req.method === 'GET' && /^\/session\/[^/]+$/.test(url.pathname)) {
      return jsonResponse(res, 200, state.sessions[0]);
    }

    if (route === 'GET /question') return jsonResponse(res, 200, state.questions);
    if (route === 'GET /permission') return jsonResponse(res, 200, state.permissions);

    if (route === 'POST /tui/append-prompt') {
      const body = await readBody(req);
      state.pendingPrompt = String(body.text || '');
      state.promptCalls.push({ call: 'append', text: state.pendingPrompt });
      return jsonResponse(res, 200, true);
    }

    if (route === 'POST /tui/submit-prompt') {
      state.promptCalls.push({ call: 'submit', text: state.pendingPrompt });
      // The delivery verification looks for the prompt as a user message. A fake
      // that skipped this would let a broken verification path pass.
      if (state.pendingPrompt) {
        const message = addMessage({ role: 'user', text: state.pendingPrompt });
        // Confirmed by the closing run: the runtime admits the prompt and names
        // the message it produced. That id is what ties a ledger row to its
        // cost, so a fake that stayed silent here would leave the usage path
        // untestable.
        emit('session.next.prompt.admitted', {
          messageID: message.info.id,
          delivery: 'steer',
          timestamp: Date.now(),
        });
      }
      state.pendingPrompt = null;
      return jsonResponse(res, 200, true);
    }

    return jsonResponse(res, 404, { error: `unhandled ${route}` });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  return {
    port,
    sessionId,
    sessionTitle,
    emit,
    addMessage,
    // What the agent was told, in order. `appends` and `submits` are what the
    // duplicate-prompt regressions are really about.
    promptCalls: () => state.promptCalls.slice(),
    appends: () => state.promptCalls.filter((entry) => entry.call === 'append'),
    submits: () => state.promptCalls.filter((entry) => entry.call === 'submit'),
    messages: () => state.messages.slice(),
    subscriberCount: () => state.subscribers.size,
    setQuestions: (questions) => { state.questions = questions; },
    setPermissions: (permissions) => { state.permissions = permissions; },
    // Drops every open stream, which is how the state machine learns it no
    // longer knows anything.
    dropStreams: () => {
      for (const res of state.subscribers) {
        try { res.end(); } catch (_) { /* already gone */ }
      }
      state.subscribers.clear();
    },
    close: () => new Promise((resolve) => {
      for (const res of state.subscribers) {
        try { res.end(); } catch (_) { /* already gone */ }
      }
      state.subscribers.clear();
      server.close(resolve);
    }),
  };
}

module.exports = {
  createFakeOpencodeServer,
};
