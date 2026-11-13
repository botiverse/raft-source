// Task #775: math in messages, with Obsidian's (Pandoc's) dollar rules.
//
// `$$…$$` is math wherever it appears (display when it stands on its own
// lines, inline otherwise). A single pair `$…$` is math only when it reads as
// math rather than as money:
//   - the opening `$` is not followed by a space;
//   - the closing `$` is not preceded by a space and not followed by a digit.
// So `$x^2$` is math, while `$5 到 $10` and `$5 and $ 10` stay text.
//
// micromark-extension-math can turn single dollars on or off but has no
// "not followed by a digit" rule, so the inline construct below is its
// `mathText` with those rules added for a single `$`. It emits the same
// tokens, so `mdast-util-math` builds the same `inlineMath` nodes.

import { math } from "micromark-extension-math";
import type {
  Code,
  Construct,
  Effects,
  Event,
  Extension,
  State,
  Token,
  TokenizeContext,
} from "micromark-util-types";

const DOLLAR = 36;
const SPACE = 32;
const DIGIT_0 = 48;
const DIGIT_9 = 57;

function isLineEnding(code: Code): boolean {
  return code !== null && code < -2;
}

function isWhitespace(code: Code): boolean {
  // Line endings (< -2), tab (-2), virtual space (-1), space.
  return code !== null && (code < 0 || code === SPACE);
}

function isDigit(code: Code): boolean {
  return code !== null && code >= DIGIT_0 && code <= DIGIT_9;
}

function previous(this: TokenizeContext, code: Code): boolean {
  // A `$` right after another `$` is part of that sequence, unless escaped.
  return code !== DOLLAR || this.events[this.events.length - 1]![1].type === "characterEscape";
}

function tokenizeMathText(
  this: TokenizeContext,
  effects: Effects,
  ok: State,
  nok: State,
): State {
  let sizeOpen = 0;
  let size = 0;
  let token: Token;
  // What came right before the current position inside the math, for the
  // single-dollar closing rule.
  let lastWasWhitespace = false;

  return start;

  function start(code: Code): State | undefined {
    effects.enter("mathText");
    effects.enter("mathTextSequence");
    return sequenceOpen(code);
  }

  function sequenceOpen(code: Code): State | undefined {
    if (code === DOLLAR) {
      effects.consume(code);
      sizeOpen++;
      return sequenceOpen;
    }
    // A single `$` opens only when text follows it at once.
    if (sizeOpen === 1 && (code === null || isWhitespace(code))) return nok(code);
    effects.exit("mathTextSequence");
    return between(code);
  }

  function between(code: Code): State | undefined {
    if (code === null) return nok(code);
    if (code === DOLLAR) {
      token = effects.enter("mathTextSequence");
      size = 0;
      return sequenceClose(code);
    }
    if (code === SPACE) {
      effects.enter("space");
      effects.consume(code);
      effects.exit("space");
      lastWasWhitespace = true;
      return between;
    }
    if (isLineEnding(code)) {
      // Single-dollar math stays on one line, as in Obsidian.
      if (sizeOpen === 1) return nok(code);
      effects.enter("lineEnding");
      effects.consume(code);
      effects.exit("lineEnding");
      lastWasWhitespace = true;
      return between;
    }
    effects.enter("mathTextData");
    return data(code);
  }

  function data(code: Code): State | undefined {
    if (code === null || code === SPACE || code === DOLLAR || isLineEnding(code)) {
      effects.exit("mathTextData");
      return between(code);
    }
    effects.consume(code);
    lastWasWhitespace = isWhitespace(code);
    return data;
  }

  function sequenceClose(code: Code): State | undefined {
    if (code === DOLLAR) {
      effects.consume(code);
      size++;
      return sequenceClose;
    }
    const closes =
      size === sizeOpen &&
      // A single closing `$` must hug the math and not start a number.
      (sizeOpen !== 1 || (!lastWasWhitespace && !isDigit(code)));
    if (closes) {
      effects.exit("mathTextSequence");
      effects.exit("mathText");
      return ok(code);
    }
    // Not the closing sequence: these dollars are part of the math.
    token.type = "mathTextData";
    lastWasWhitespace = false;
    return data(code);
  }
}

// Same as micromark-extension-math: trim one space of padding on each side
// when both are present, and merge spaces into the data.
function resolveMathText(events: Event[]): Event[] {
  let tailExitIndex = events.length - 4;
  let headEnterIndex = 3;
  let index: number;
  let enter: number | undefined;

  if (
    (events[headEnterIndex]![1].type === "lineEnding" || events[headEnterIndex]![1].type === "space") &&
    (events[tailExitIndex]![1].type === "lineEnding" || events[tailExitIndex]![1].type === "space")
  ) {
    index = headEnterIndex;
    while (++index < tailExitIndex) {
      if (events[index]![1].type === "mathTextData") {
        events[tailExitIndex]![1].type = "mathTextPadding";
        events[headEnterIndex]![1].type = "mathTextPadding";
        headEnterIndex += 2;
        tailExitIndex -= 2;
        break;
      }
    }
  }

  index = headEnterIndex - 1;
  tailExitIndex++;
  while (++index <= tailExitIndex) {
    if (enter === undefined) {
      if (index !== tailExitIndex && events[index]![1].type !== "lineEnding") enter = index;
    } else if (index === tailExitIndex || events[index]![1].type === "lineEnding") {
      events[enter]![1].type = "mathTextData";
      if (index !== enter + 2) {
        events[enter]![1].end = events[index - 1]![1].end;
        events.splice(enter + 2, index - enter - 2);
        tailExitIndex -= index - enter - 2;
        index = enter + 2;
      }
      enter = undefined;
    }
  }
  return events;
}

const raftMathText: Construct = {
  name: "mathText",
  tokenize: tokenizeMathText,
  resolve: resolveMathText,
  previous,
};

/**
 * The micromark extension for Raft math: `$$` blocks and inline `$$…$$` from
 * micromark-extension-math, and inline `$…$` with the Obsidian rules above.
 * Pair it with `mathFromMarkdown()` from mdast-util-math.
 */
export function raftMath(): Extension {
  const base = math({ singleDollarTextMath: false });
  return { flow: base.flow, text: { [DOLLAR]: raftMathText } };
}
