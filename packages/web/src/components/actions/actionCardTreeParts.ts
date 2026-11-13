// What the spec card frame (ActionCardSpecCard) leaves out of a tree it
// draws: buttons a viewer can't use, and a question card's question rows when
// the card itself asks them (question-card spec §5.9: QuestionInlineForm draws
// each question with its options in their place).

import { questionElementId } from "@botiverse/raft-shared";
import type { ActionCardRenderedCard, ActionCardSpecEntityRef, ActionCardSpecForm, ActionCardSpecField, ActionCardSpecMsg, ActionCardSpecMsgParam, ActionCardSpecUnsupportedField } from "@botiverse/raft-shared";
import type { ActionCardRenderedButton, ActionCardRenderedTree } from "./ActionCardSpecRenderer";

type TreeNode = ActionCardRenderedTree["elements"][string];

/**
 * `tree` without the elements `hide` picks, and without an actions row they
 * leave empty: what the frame shows this viewer.
 */
export function withoutElements(tree: ActionCardRenderedTree, hide: (id: string, node: TreeNode) => boolean): ActionCardRenderedTree {
  const hidden = new Set(Object.entries(tree.elements).filter(([id, node]) => id !== tree.root && hide(id, node)).map(([id]) => id));
  if (hidden.size === 0) return tree;
  const elements = { ...tree.elements };
  for (const id of hidden) delete elements[id];
  for (const [id, node] of Object.entries(elements)) {
    if (node.type !== "Stack" || !node.children) continue;
    const children = node.children.filter((child) => !hidden.has(child));
    if (children.length === node.children.length) continue;
    elements[id] = { ...node, children };
    if (children.length === 0 && node.props.direction === "row") hidden.add(id);
  }
  // An emptied row goes from its parent too.
  for (const [id, node] of Object.entries(elements)) {
    if (hidden.has(id)) { delete elements[id]; continue; }
    if (node.type === "Stack" && node.children?.some((child) => hidden.has(child))) elements[id] = { ...node, children: node.children.filter((child) => !hidden.has(child)) };
  }
  return { ...tree, elements };
}

/**
 * `tree` with the `kind` references among its Texts' Msg params given as text,
 * `nameOf(ref)`: for a line that names someone in prose, by display name,
 * rather than as an @handle mention (the Msg's text puts the param in place).
 */
export function withTextEntityParamsAsNames(tree: ActionCardRenderedTree, kind: ActionCardSpecEntityRef["kind"], nameOf: (ref: ActionCardSpecEntityRef) => string): ActionCardRenderedTree {
  const named = (value: ActionCardSpecMsgParam) => (typeof value === "object" && value.kind === kind ? nameOf(value) : value);
  let changed = false;
  const elements: Record<string, TreeNode> = {};
  for (const [id, node] of Object.entries(tree.elements)) {
    const params = node.type === "Text" && typeof node.props.text !== "string" ? node.props.text.params : undefined;
    if (node.type !== "Text" || typeof node.props.text === "string" || !params || Object.values(params).every((value) => named(value) === value)) {
      elements[id] = node;
      continue;
    }
    changed = true;
    const text = { ...node.props.text, params: Object.fromEntries(Object.entries(params).map(([name, value]) => [name, named(value)])) };
    elements[id] = { ...node, props: { ...node.props, text } };
  }
  return changed ? { ...tree, elements } : tree;
}

/** The element ids of `tree` in reading order: from its root, through each Stack's children. */
function idsInReadingOrder(tree: ActionCardRenderedTree): string[] {
  const out: string[] = [];
  const visit = (id: string) => {
    const node = tree.elements[id];
    if (!node || out.includes(id)) return;
    out.push(id);
    if (node.type === "Stack") node.children?.forEach(visit);
  };
  visit(tree.root);
  return out;
}

/**
 * `card` with one Reload where it has several (the web's "Open in web", Q8:
 * actionCardUnrunnableOpensInWeb): each tree keeps the first enabled button
 * strip turned into Open in web, in reading order, and drops the other enabled
 * ones, so the card shows one Reload beside one line. A disabled one keeps its
 * own reason.
 */
export function withOneReload(card: ActionCardRenderedCard): ActionCardRenderedCard {
  const one = (tree: ActionCardRenderedTree) => {
    const reloads = idsInReadingOrder(tree).filter((id) => {
      const node = tree.elements[id];
      return node?.type === "Button" && node.props.action.kind === "open_web" && !node.props.disabledReason;
    });
    return reloads.length < 2 ? tree : withoutElements(tree, (id) => reloads.slice(1).includes(id));
  };
  return { ...card, spec: one(card.spec), ...(card.result ? { result: one(card.result) } : {}) };
}

/** `tree` without the Buttons `hide` picks (withoutElements). */
export function withoutButtons(tree: ActionCardRenderedTree, hide: (button: ActionCardRenderedButton) => boolean): ActionCardRenderedTree {
  return withoutElements(tree, (_id, node) => node.type === "Button" && hide(node.props));
}

/** A question card's form answered on the card (placement `inline`), and the button that would open it in the sheet. */
export interface InlineQuestionForm {
  formId: string;
  form: ActionCardSpecForm<ActionCardSpecField | ActionCardSpecUnsupportedField>;
  fields: Extract<ActionCardSpecField, { type: "Choice" }>[];
  buttonId: string;
  /** The button's label: the card's one submit says the same ("Answer Question(s)"). */
  buttonLabel: ActionCardSpecMsg;
}

/**
 * The form a card's body asks inline: the first `open_form` button's form
 * when it is `placement: "inline"` and every field a Choice (the server only
 * places such forms, questionAskPlacement); else null, and the button opens
 * the sheet as it always did. A client without `field.choice` never gets
 * here: strip turned the button into Open in web.
 */
export function inlineQuestionForm(card: ActionCardRenderedCard): InlineQuestionForm | null {
  for (const [buttonId, node] of Object.entries(card.spec.elements)) {
    if (node.type !== "Button" || node.props.action.kind !== "open_form") continue;
    const formId = node.props.action.form;
    const form = card.forms && Object.hasOwn(card.forms, formId) ? card.forms[formId] : undefined;
    if (!form || form.placement !== "inline") return null;
    const fields = form.fields.filter((field): field is Extract<ActionCardSpecField, { type: "Choice" }> => field.type === "Choice");
    return fields.length === form.fields.length ? { formId, form, fields, buttonId, buttonLabel: node.props.label } : null;
  }
  return null;
}

/**
 * The body without what the inline form draws itself: its button, and each
 * question's row (the server's Field `questionElementId("q", id)`, shared
 * buildQuestionAskCard), which the form shows numbered, over its options.
 */
export function withoutInlineQuestions(tree: ActionCardRenderedTree, inline: InlineQuestionForm): ActionCardRenderedTree {
  const rows = new Set(inline.fields.map((field) => questionElementId("q", field.name)));
  return withoutElements(tree, (id, node) => (node.type === "Button" && id === inline.buttonId) || (node.type === "Field" && rows.has(id)));
}

/**
 * A done card's result section's first item, which its folded header names
 * after the arrow (handoffs-and-approvals.md: done, then a link to what was
 * made): the first Text, Field or EntityRef in the tree's order, through its
 * Stacks, past its buttons. Null when the section starts with anything else
 * or holds nothing to name.
 */
export function resultHeadline(tree: ActionCardRenderedTree): TreeNode | null {
  const visit = (id: string, depth: number): TreeNode | null | undefined => {
    const node = Object.hasOwn(tree.elements, id) ? tree.elements[id] : undefined;
    if (!node || depth > 8) return undefined;
    switch (node.type) {
      case "Text":
      case "Field":
      case "EntityRef":
        return node;
      case "Button":
        return undefined;
      case "Stack": {
        if (node.props.role === "actions") return undefined;
        for (const child of node.children ?? []) {
          const found = visit(child, depth + 1);
          if (found !== undefined) return found;
        }
        return undefined;
      }
      default:
        // A first item the header can't name in a line (a badge, a time, a notice, a scope list): nothing.
        return null;
    }
  };
  return visit(tree.root, 0) ?? null;
}

/**
 * A done card's body with its result in it, after everything the person
 * checked and before the agent's reason (DS: one list measures one label
 * column, so a second list beside it misaligns): the Fields straight in the
 * result's root column join the body's first property list after its last
 * row; the result's other items (a summary, a note, a group) go just before
 * the body's tail, its reason, else its buttons, else its end, never between
 * two of its sections. Without a list in the body, the rows go there too. The
 * result keeps only its buttons, drawn under the body as the card's last row.
 */
export function withResultRows(body: ActionCardRenderedTree, result: ActionCardRenderedTree): { body: ActionCardRenderedTree; result: ActionCardRenderedTree } {
  const resultRoot = result.elements[result.root];
  const bodyRoot = body.elements[body.root];
  if (resultRoot?.type !== "Stack" || bodyRoot?.type !== "Stack") return { body, result };
  const isButtons = (node: TreeNode | undefined) => node?.type === "Button"
    || (node?.type === "Stack" && (node.props.role === "actions"
      || (node.props.direction === "row" && (node.children ?? []).length > 0 && (node.children ?? []).every((child) => result.elements[child]?.type === "Button"))));
  const top = resultRoot.children ?? [];
  const rows = top.filter((id) => result.elements[id]?.type === "Field");
  const items = top.filter((id) => result.elements[id]?.type !== "Field" && !isButtons(result.elements[id]));
  if (rows.length === 0 && items.length === 0) return { body, result };
  const elements = { ...body.elements };
  // Copied in under ids of their own (a group with its children): the two trees name their elements independently.
  const copy = (id: string, depth: number): string | null => {
    const node = result.elements[id];
    if (!node || depth > 8) return null;
    let copyId = `result.${id}`;
    while (Object.hasOwn(elements, copyId)) copyId = `${copyId}_`;
    elements[copyId] = node;
    if (node.type === "Stack" && node.children) {
      elements[copyId] = { ...node, children: node.children.map((child) => copy(child, depth + 1)).filter((child): child is string => child !== null) };
    }
    return copyId;
  };
  const rowIds = rows.map((id) => copy(id, 0)).filter((id): id is string => id !== null);
  const itemIds = items.map((id) => copy(id, 0)).filter((id): id is string => id !== null);
  const isField = (id: string) => elements[id]?.type === "Field";
  // The first Stack (the root column included) holding a Field: the body's property list.
  const listStack = (id: string, depth: number): string | null => {
    const node = elements[id];
    if (node?.type !== "Stack" || depth > 8 || node.props.role === "actions" || node.props.role === "reason" || node.props.direction === "row") return null;
    const children = node.children ?? [];
    if (children.some(isField)) return id;
    for (const child of children) {
      const found = listStack(child, depth + 1);
      if (found) return found;
    }
    return null;
  };
  const rootChildren = [...(bodyRoot.children ?? [])];
  // The body's tail: its reason, its buttons (an actions row, or a row or run of Buttons).
  const isTail = (id: string) => {
    const node = elements[id];
    return node?.type === "Button" || (node?.type === "Stack" && (node.props.role === "reason" || node.props.role === "actions"
      || (node.props.direction === "row" && (node.children ?? []).length > 0 && (node.children ?? []).every((child) => elements[child]?.type === "Button"))));
  };
  const tailAt = () => {
    const at = rootChildren.findIndex(isTail);
    return at === -1 ? rootChildren.length : at;
  };
  const target = listStack(body.root, 0);
  if (target) {
    const stack = elements[target] as Extract<TreeNode, { type: "Stack" }>;
    const children = [...(target === body.root ? rootChildren : (stack.children ?? []))];
    let end = children.findIndex(isField);
    while (end + 1 < children.length && isField(children[end + 1]!)) end++;
    children.splice(end + 1, 0, ...rowIds);
    if (target === body.root) rootChildren.splice(0, rootChildren.length, ...children);
    else elements[target] = { ...stack, children };
  } else {
    rootChildren.splice(tailAt(), 0, ...rowIds);
  }
  rootChildren.splice(tailAt(), 0, ...itemIds);
  elements[body.root] = { ...(elements[body.root] as Extract<TreeNode, { type: "Stack" }>), children: rootChildren };
  const moved = new Set([...rows, ...items]);
  return { body: { ...body, elements }, result: withoutElements(result, (id) => moved.has(id)) };
}
