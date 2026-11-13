import {
  SearchMessageResult,
  SearchMessageResultBody,
  SearchMessageResultHeader,
  SearchMessageResultMeta,
  SearchMessageResultSender,
  SearchMessageResultTimestamp,
  SearchResultsList,
  Skeleton,
} from "@botiverse/raft-ui";
import { SkeletonTextBar } from "../../components/ui/Skeleton";
import { SEARCH_HIT_AVATAR_BOX, SEARCH_HIT_TEXT_INSET } from "./searchHitGeometry";

// Loading keeps the hit layout (DS Loading: a known layout gets a skeleton),
// built from the hit's own parts (raft-ui SearchMessageResult in the results
// list, MessageHitRow's identity and text insets): the 27px identity, the
// who / where / time line and the excerpt, one line with a mouse on a desktop
// and two on a phone, where the narrower column wraps it.
export function SearchSkeleton() {
  return (
    <SearchResultsList>
      {Array.from({ length: 5 }, (_, index) => (
        <SearchMessageResult
          key={index}
          render={<div />}
          aria-hidden="true"
          data-skeleton=""
          className={`pointer-events-none ${SEARCH_HIT_TEXT_INSET}`}
        >
          <SearchMessageResultHeader>
            <SearchMessageResultMeta>
              <SkeletonTextBar className="w-20" />
            </SearchMessageResultMeta>
            <SearchMessageResultSender>
              <span className={SEARCH_HIT_AVATAR_BOX}>
                <Skeleton className="size-[27px]" />
              </span>
              <span><SkeletonTextBar className="w-24" /></span>
            </SearchMessageResultSender>
            <SearchMessageResultTimestamp>
              <SkeletonTextBar className="w-12" />
            </SearchMessageResultTimestamp>
          </SearchMessageResultHeader>
          <SearchMessageResultBody>
            <div><SkeletonTextBar className="w-4/5" /></div>
            <div className="md:pointer-fine:hidden"><SkeletonTextBar className="w-1/2" /></div>
          </SearchMessageResultBody>
        </SearchMessageResult>
      ))}
    </SearchResultsList>
  );
}
