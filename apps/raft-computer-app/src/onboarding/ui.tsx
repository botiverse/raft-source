import React from "react";

export function RaftMark({ size = 30 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 113 104"
      fill="none"
      style={{ flexShrink: 0 }}
    >
      <path
        d="M112.754 38.7427L108.8 16.3029C108.228 13.0949 106.323 10.5063 103.797 8.4577C102.543 7.44132 98.0803 3.58224 96.2699 2.18472C93.7131 0.183714 90.3622 -0.324477 87.186 0.183714L21.8199 11.8404C16.8809 12.5709 12.9424 13.4761 9.90915 17.5893C6.39945 22.3377 7.43172 26.9273 8.25753 31.6122L11.3384 49.1289C11.4655 49.8435 11.6719 50.5105 11.8943 51.1617C7.57465 51.9239 4.16024 53.4803 2.07983 56.5453C-0.175272 59.8644 -0.349963 62.2942 0.396443 66.5503L3.92202 86.5603C4.82724 90.7688 8.03519 92.9286 12.7042 97.1212C18.1196 101.949 20.2635 104.649 25.679 103.696L96.3017 91.2452C102.892 90.07 107.307 83.7812 106.148 77.1906L102.273 55.1795C102.146 54.4331 101.939 53.7185 101.685 53.0356L102.972 52.7974C109.515 51.6063 113.898 45.3016 112.754 38.7586V38.7427Z"
        fill="#141111"
      />
      <path
        d="M18.3261 87.1956L85.1691 75.4119C87.3607 75.0307 88.8217 72.9345 88.4247 70.7588L85.2168 52.5274C84.8356 50.3358 82.7393 48.8748 80.5636 49.2718C78.3721 49.6529 75.9105 50.0976 74.6718 50.3199C72.7184 50.6693 69.3993 49.4624 68.8276 46.2544L67.7953 40.4102L38.8761 71.9181C37.9708 72.7439 35.9063 73.8397 33.7624 73.3315C31.9043 72.8868 30.5544 71.267 30.2209 69.393L28.2993 58.4828L13.7206 61.0555C11.529 61.4525 10.068 63.5329 10.4491 65.7086L13.6571 83.9241C14.0382 86.1157 16.1345 87.5767 18.3102 87.1797L18.3261 87.1956Z"
        fill="#FFFAEF"
      />
      <path
        d="M20.9147 45.508C21.3117 47.6996 23.3921 49.1607 25.5678 48.7795L31.4914 47.7314C34.2229 47.2549 36.8274 49.0812 37.3038 51.7969L38.3361 57.6411L67.2554 26.1332C68.5417 24.7357 70.5268 24.1799 72.369 24.7198C74.1954 25.2598 75.577 26.7844 75.9105 28.6583L77.8321 39.5368L91.7756 36.9958C93.9513 36.5988 95.3965 34.5184 95.0153 32.3427L91.7279 13.6825C91.3468 11.491 89.2505 10.0299 87.0589 10.4269L20.867 22.1948C18.6754 22.5759 17.2303 24.6722 17.6114 26.8479L20.8988 45.4921L20.9147 45.508Z"
        fill="#FFFAEF"
      />
    </svg>
  );
}

export function Spinner() {
  return <div className="onb-spinner" />;
}

export function Pill({
  children,
  variant = "warning",
}: {
  children: React.ReactNode;
  variant?: "warning" | "success";
}) {
  return (
    <span
      className={`onb-pill ${variant === "success" ? "onb-pill--success" : ""}`}
    >
      {children}
    </span>
  );
}

export function Button({
  children,
  onClick,
  variant = "primary",
  disabled = false,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  variant?: "primary" | "dark";
  disabled?: boolean;
}) {
  return (
    <button
      className={`onb-btn ${variant === "dark" ? "onb-btn--dark" : ""}`}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

export function TextLink({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick?: () => void;
}) {
  return (
    <button className="onb-link" onClick={onClick}>
      {children}
    </button>
  );
}

export function WorkspaceAvatar({ name }: { name: string }) {
  return <div className="onb-ws-avatar">{name.charAt(0).toUpperCase()}</div>;
}
