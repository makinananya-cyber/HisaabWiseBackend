# ADR-0019 — The currency token rule, and what a residual `saved` means on day one

**Status:** accepted, with one open product question (§2)
**Relates to:** [ADR-0001](0001-money-representation.md), [ADR-0003](0003-budget-outputs.md), Product Spec §4.1 and §4.2, invariants 1 and 3

Two findings from implementing the money domain. The first is settled; the second needs the owner.

---

## 1. Which token a currency is shown with — settled

Product Spec §4.1 says: *"multi-letter codes get a space (`AED 500`); single-symbol currencies don't
(`₹500`)"*. That sentence is not quite a rule, and the fixture corpus contains two cases it gets wrong.
`money-exponents.json` carries **`JPY 75,000`** and **`KRW 680,000`** — not `¥75,000` and `₩680,000` —
even though `¥` and `₩` are both single characters.

One rule explains every entry in the corpus:

> **Use the currency's symbol when it is a single character *and* unique across the 160-currency list.
> Otherwise use the ISO code, with a space.**

`¥` is shared by CNY and JPY. `₩` is shared by KPW and KRW. Both are therefore ambiguous and fall back to
the code, which is what the corpus shows. `₹` belongs to INR alone, so it is used.

**The rule earns its keep well beyond those two cases**, which is why it was adopted rather than
special-cased:

| Symbol | Shared by | Token used |
|---|---|---|
| `$` | 25 currencies — USD, AUD, CAD, SGD, HKD, … | the code |
| `£` | 6 — GBP, FKP, GIP, SHP, SSP, SYP | the code |
| `Rs` | PKR, NPR, LKR | the code |
| `¥` | CNY, JPY | the code |
| `₹` | INR alone | `₹` |

A salaried expatriate in the UAE choosing between AED, USD, AUD and SGD would otherwise see `$8,000` with
nothing to say which dollar. `Rs` is the same problem for the Pakistani, Nepali and Sri Lankan users who
are squarely in the target market. Twenty-nine currencies keep a symbol; the rest use their code.

The prototype had none of this: `HWMoney` used whatever `currencySymbol` the user record happened to hold,
which for its own default user was the literal string `AED`.

The rounding ladder and the gap rule are transcribed from the prototype's own `HWMoney` unchanged, because
the numbers a user sees have to agree with the design the product was signed off against.

---

## 2. `saved` is a residual, so a fresh account reads 500% of its goal — **open**

Product Spec §4.2 defines, without a first-run exception:

```
saved = max(0, income − needs − wantsSpent)
```

and explains why: there is no bank link and no savings-transfer ledger, so the residual is the only
quantity the server can honestly derive. That is implemented exactly, in one place, with no branches.

**The consequence.** A user who registers with a ₹65,000 salary and a ₹13,000 goal and has logged nothing
sees, on their very first Home screen:

```
saved            ₹65,000
percentageLabel  "500% of goal"
verdict          met          (a full meter)
remaining        null
```

Which is arithmetically correct — they have not spent anything, so the residual *is* their salary — and
reads as a congratulation for having done nothing. The meter is a **projection** ("what you keep if you
stop here"), and it is labelled as an **achievement** ("% of goal").

`home-first-run.json` shows `saved: 0`, `verdict: low`, and the full goal remaining. That fixture's
*figures* are explicitly not contract ([ADR-0017](0017-contract-testing-against-the-ios-corpus.md) — shape
and formatting are asserted, figures are not), so it does not settle the question. But it is evidence of
what the design intended the first screen to say.

**Implemented for now:** the spec, literally. Two reasons. The engine exists exactly once (invariant 3),
and a first-run branch inside it is precisely the second code path that produced defect D1 — the
prototype's Home and Account disagreeing about the same number. And the residual is not wrong at any other
point in the month: a user who has logged half a month of spending gets a meaningful figure from it.

**What the owner needs to decide**, because it changes the first screen every user sees:

| Option | Behaviour | Cost |
|---|---|---|
| **A — leave it** (current) | The meter is a forward projection from day one. | A new user is told they hit 500% of their goal before doing anything. |
| **B — clamp on first run** | When nothing at all has been logged this month, report `saved` as zero. | One condition, at the *screen* rather than in the engine, keyed on the `isFirstRun` the payload already carries. The engine stays branchless; Reports and `/v1/budget` are untouched. |
| **C — relabel** | Keep the figure, change the copy to "on track to save" rather than "% of goal". | A content and design change, not a backend one, and it makes the projection honest instead of hiding it. |

**Recommendation: B for the first run, and C considered separately.** B costs one condition in
`src/screens/home.ts` and removes a bad first impression; it does not touch the engine, so invariant 3
holds. C is the better long-term answer and is a design conversation rather than a code change.

Nothing downstream depends on the answer — it is one condition in one file — so this is not blocking any
later slice.
