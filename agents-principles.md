# Agent Principles

Do not create complexity to look smart. Create clarity so the project is easier to continue.

## Core Principles

- Prefer low coupling and high cohesion.
- Follow SOLID principles when they make the code clearer.
- Keep classes focused on one responsibility.
- Avoid very large classes and very large methods.
- Prefer readable code over clever code.
- Avoid over-engineering.
- Keep architecture simple until complexity is justified.
- Organize files in clear folders based on responsibility.
- Avoid mixing UI, networking, gameplay logic, and persistence in the same class.
- Respect the existing project structure before creating new folders or patterns.
- Avoid duplicated logic.
- Avoid hidden side effects.
- Prefer explicit error handling over silent failures.
- Use interfaces when they reduce coupling, not just for appearance.
- Stay inside the task scope.
- If a related problem is discovered, report it instead of silently expanding the task.
- For large tasks, create or update tests when practical.
- If automated tests are not practical, provide a manual test checklist.
- A task is not complete until there is a way to verify it.
- Do not rewrite large parts of the project unless explicitly asked.
- Prefer incremental changes that are easy to review.

## Project-Specific Principles

This section is intentionally empty in a new office.

Add principles that apply to this specific codebase: which module owns which
concern, which layers must not be mixed, and any convention a new agent would
otherwise have to infer from reading the whole repository. Keep them concrete
enough to be checkable in review.

Do not restate the core principles above here.

## Seams: who writes this, and who reads it

A seam is any place data crosses between parts of the system: between processes,
between modules, between a producer and the thing that consumes it.

**A change that touches a seam is not done until this question has been answered
out loud, in the task report.** It is a criterion for completion, not advice.

For every field or result the change touches at a boundary, name:

1. **Who writes it.** Exactly one place, unless a second is declared with its
   reason. Zero is a bug that looks like nothing happening.
2. **Who reads it.** If a reader expects a value in a case the writer never
   covers, the system deadlocks and every test still passes.
3. **Whether anyone discards a result.** A function that reports failure by
   returning rather than throwing will be read as success by somebody.
4. **Whether the value survives the trip.** Between the writer and the reader
   there is often a projection: an object literal rebuilt from another object,
   listing the fields somebody thought the far side needed. Every field a
   decision depends on has to be on that list.

The five failure shapes, and each has been hit for real in this codebase:

- **Two writers** — they diverge, and the UI shows one thing while the scheduler
  believes another.
- **No writer** — a reader waits forever for a field nobody fills.
- **A discarded result** — a refusal that does not throw is treated as success.
- **A field dropped in a narrow projection** — the writer wrote it, the reader
  read it, and it stopped existing in between.
- **A missing producer** — the design says one value comes from another, and
  nobody wrote the code that joins them. See the section below: the question is
  who *produces* this, not only who writes it.

The fourth is the one that escapes the other three questions, because both of
their answers are correct. It has been hit twice. `reserveTaskForSession`
returned `{id, title, status}`, so the task's `attempt` never reached the
dispatcher and every retry of a released task was refused as a duplicate of the
prompt that failed. The projection into `factsFor` left out `opencodeSessionId`,
so the module that resolves sessions could not see the id it was resolving.

Both were found by driving the whole path, never by reading either end. Two
things follow:

- **A projection is a place a decision can be lost, so name the decision.** If
  the far side branches on a field, that field belongs on the list — and prefer
  spreading the source object over enumerating fields when the far side is
  inside this system and the shape is not a contract with something external.
- **This is the shape no static check can catch**, and the reason the seam tests
  run through real wiring. A single-writer validator can count writers; nothing
  can tell that a field a reader needs was silently not carried. Only running
  the path finds it.

Two further rules that follow from it:

- **Every condition that blocks needs a defined way to unblock, designed in the
  same change that adds the condition.** Not later. A guard with no exit stops
  the system in a way that looks like a hang, not a failure.
- **Each seam needs at least one test through the real wiring**, using the
  production configuration rather than injected doubles. Doubles are for edge
  cases. A double cannot tell you the real cable is unplugged, which is why a
  full suite of them can stay green over a completely deadlocked system.
- **Keep the fast check fast, and the slow one separate.** Scenario tests that
  start servers belong in their own command. A suite that takes minutes stops
  being run while you work, and a safety net nobody runs turns itself off. Both
  must pass before committing.

Record each seam you touch in the project's seam map, next to the ones already
there. That document is the map this kind of system needs and does not otherwise
have.

## Who produces this, not just who writes it

The four seam shapes ask about a field: who writes it, who reads it. That misses
a whole class, because not every value is stored.

A blueprint's instances showed nothing for a while. The instance held its
reference, the blueprint held its definition, the renderer drew what it was
handed — every piece correct, every unit test green. What was missing was the
code that JOINS them: a linked instance carries no definition of its own, so
something has to resolve it, and nobody had written that something. The design
assumed it existed.

It was a **missing piece, not a wrong one**, and no test of a piece can find it.
Each one asserts its piece and passes. None asks "and who produces the value
neither of us stores".

So the seam question generalises: **who produces this?** — which includes "who
writes this" and also covers the derived value that lives in no field. When a
design says "X comes from Y", name the function that does the coming-from. If
you cannot name it, that is the bug.

The test that catches this asserts the OUTCOME, not the mechanism: after
instancing a blueprint, the cartridge has that blueprint's name and model. It
does not know which function resolves anything, so it fails wherever the chain
broke — including at a link nobody has written yet. And it has to run through the
real wiring: the missing piece there was an argument never being passed, so a
test that supplied that argument itself would have gone green through the entire
bug.

Only assert what can be written as a value. "The cartridge shows the right name"
is data and belongs here. "The animation feels right" is an adjective and belongs
to a person's eyes.

## The irreversible step goes last

An operation that touches several things has an order, and the order is decided
by which step cannot be undone.

**Do not advance the state that permits recovery until everything reversible has
gone right.** Three operations in this codebase turn on it:

- Committing a placement does not advance the last-committed snapshot until the
  write lands, so a failure retries instead of losing the position.
- Deleting a blueprint unlinks every instance first and removes the blueprint
  last. The blueprint is the only thing an orphaned instance can be rebuilt
  from, so it goes last: fail partway and nothing is orphaned, retry and it
  finishes. The other order leaves instances pointing at something gone, with
  nothing left to rebuild their definition from.
- Editing a blueprint stops or unlinks the running instances first and writes
  the edit last. Write it first and fail to stop a session, and there is an
  agent running whose definition changed underneath it.

And the companion rule: **if any part cannot be reached, the whole operation is
refused, naming what blocked it.** Partial completion is the one outcome that
cannot be undone. Refusing is ugly and recoverable; half-done is tidy and is not.

That rule needs care about what counts as "cannot be reached". A project that no
longer exists cannot be holding anything, so it must not block — nine of twelve
entries in this machine's recent-projects list were already gone, and treating
those as blockers would have refused every delete forever, for a list nobody
prunes. A project that is present and unreadable is the opposite: something is
there, it may hold what you are about to orphan, and the cause is usually
transient. Only that blocks.

## A check is proved by making it fail

A new check is not proved by watching it pass. It is proved by **breaking the
thing it guards and confirming it fails — and that it fails naming the real
site**. A validator that has never been red is not a validator, it is a line that
runs.

This has already happened twice here, by different routes, and both times the
green belonged to the process rather than to the test:

- A check written specifically against the family "a safeguard that exists and
  does nothing" **was** one on its first version. It looked for discarded calls
  with a pattern that excluded every method call in the codebase, so it passed
  while examining almost nothing. Injecting a real discarded call and watching it
  stay green is what found it.
- The scenario suites printed "passed" and then hung, because they were being run
  under a timeout that killed them after the last line. The output was true and
  the process was broken.

**And when a measurement gives you a reassuring answer that does not explain the
symptom, suspect the measurement before the code.** Three times here the green
belonged to the instrument rather than to the system: a timeout that killed
scenario suites after their last line, so they printed "passed" and were hanging;
a validator whose pattern excluded every method call, so it examined almost
nothing and passed; and a diagnostic that filtered rules by `rule.cssRules`,
which every rule has under CSS Nesting, so it skipped them all and reported "no
rule matches". Each time the reassuring answer was the wrong one, and each time
the symptom was still sitting there unexplained. That gap is the tell.

Two things follow, and the second is the one people skip:

- **Break it in the direction you care about.** Rename the state, drop the field,
  discard the result. If the check does not go red, it is not checking that.
- **Make sure it cannot pass for the wrong reason.** A scan that finds nothing to
  look at passes trivially, so assert that it found something: `validate-state-
  names` requires each site to still compare at least one state, precisely so
  that a rewrite which stops comparing states fails loudly instead of going
  quietly green.

## Simple mechanisms have the most edge cases

Not a seam question. The four above ask who writes a value and who reads it —
questions about a boundary. This one is about a rule, and it has its own
question: **what does this rule do when the normal case does not hold?**

The mechanism that everything else depends on is the one whose edges nobody
enumerated, precisely because it looked too simple to need it. "Commit what
differs from the last thing committed" is four words and produced three
unintended behaviours in one feature: it re-proposed a permanently refused write
forever, because a failed write never advances what was last committed; it would
have written one project's layout into another's database across a project
switch; and its identity check compared freshly parsed objects, so it reported a
change every single time and saved nothing.

None of those are visible in the rule. They appear only when you ask what it does
when a write fails, when the project changes, when the object is not the one you
had before.

So when a small rule becomes load-bearing, list the cases where its normal
assumption breaks and write a test for each. Look for it hardest where the code
reads as too obvious to test — that is the same property that made it
load-bearing.

## Verification Principles

- Every implementation task should end with either automated verification or a manual verification checklist.
- If a change cannot be tested during the task, the report must say so clearly.
- If a risky change is merged without full verification, the report must name the residual risk.
- Agents should distinguish between technical verification and user/device validation.
- Agents should perform reproducible technical checks whenever possible.
- Real-device UX, control feel, mobile browser behavior, and subjective interaction quality should be escalated to the user for final validation.
- When a task reaches the point where user validation is needed, the agent should say so explicitly instead of assuming the experience is correct.
