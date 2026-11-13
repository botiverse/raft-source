import { Children, isValidElement } from "react";
import type { ReactNode } from "react";
import { AvatarGroup } from "@botiverse/raft-ui";

/**
 * A decorative stack of faces in a header or a button: raft-ui's AvatarGroup
 * (each face 5px over the one before, nothing between them; raft-ui 0.61.0),
 * as a <span>, so it can sit in a header's <p> or inside a button. Working
 * now, the line above a channel's composer, a thread's followers and an
 * Artifact's readers draw this one stack, so they look the same (stdrc: one
 * stack everywhere).
 *
 * Its children are the faces (AvatarSlot, at most three: the caller slices),
 * each keyed by who it is, so a new answer with the same people keeps the
 * same nodes. Decorative: the count, the sentence or the button's name beside
 * it says who.
 * A face that joins slides and fades in (DS: 180-220ms, the slide easing);
 * with reduced motion it simply appears. `still`: no entrance at all
 * (nothing moves: the typing line, raft-design 0042; an Artifact's readers;
 * a thread's followers).
 */
export function FaceStack({ children, still = false, testId }: {
  children: ReactNode;
  still?: boolean;
  testId?: string;
}) {
  return (
    <AvatarGroup render={<span />} className="shrink-0" aria-hidden="true" data-face-stack="" data-testid={testId}>
      {/* Children.map keeps each face's key on its wrapper; the overlap applies to the wrappers. */}
      {Children.map(children, (face) => (
        <span
          className={still ? "flex" : "flex motion-safe:transition-[opacity,translate] motion-safe:duration-200 motion-safe:ease-slide motion-safe:starting:-translate-x-1 motion-safe:starting:opacity-0"}
          data-face-key={isValidElement(face) && face.key !== null ? face.key : undefined}
        >
          {face}
        </span>
      ))}
    </AvatarGroup>
  );
}
