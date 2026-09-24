import { useIntl } from "react-intl";

export default function RaftBrandLockup({
  className = "h-10 w-auto",
  // Most Raft surfaces stay light even when the OS prefers dark colors.
  // Only pages that actually adapt their surface may opt into the dark asset.
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
    <div
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
