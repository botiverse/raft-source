import { useIntl } from "react-intl";

export default function RaftBrandLockup({
  className = "h-10 w-auto",
  // The default lockup is the sticker wordmark (ink outline, cream fill),
  // legible on the yellow light frame and on the dark frame alike. Only pages
  // that paint their own OS-following surface opt into the mono-light asset.
  adaptToDarkMode = false,
}: {
  className?: string;
  adaptToDarkMode?: boolean;
}) {
  const { formatMessage } = useIntl();
  const logo = (
    <img
      src="/brand/raft-logo.svg"
      alt=""
      className="block h-full w-auto"
      aria-hidden="true"
      draggable={false}
    />
  );

  return (
    // role="img": the lockup is one image named "Raft" (a plain div's
    // aria-label is not exposed). Where it stands for a word in a sentence
    // ("Login with [Raft]"), that name is the word screen readers read.
    <div
      role="img"
      className={`inline-flex select-none items-center ${className}`}
      aria-label={formatMessage({ id: "brand.productName" })}
    >
      {adaptToDarkMode ? (
        <picture className="contents">
          <source
            srcSet="/brand/raft-logo-mono-light.svg"
            media="(prefers-color-scheme: dark)"
          />
          {logo}
        </picture>
      ) : logo}
    </div>
  );
}
