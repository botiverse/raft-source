import type { InputHTMLAttributes } from "react";

type SlugInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "className"> & {
  className?: string;
  inputClassName?: string;
};

type PrefixedInputProps = SlugInputProps & {
  prefix: string;
};

export function PrefixedInput({
  prefix,
  className = "",
  inputClassName = "",
  ...props
}: PrefixedInputProps) {
  return (
    <div
      className={`input-brutal flex w-full items-stretch overflow-hidden px-0 py-0 focus-within:shadow-brutal ${className}`.trim()}
    >
      <span
        aria-hidden="true"
        className="flex shrink-0 items-center border-r-2 border-black bg-soft-signal/30 px-3 font-display font-bold text-black/70"
      >
        {prefix}
      </span>
      <input
        {...props}
        className={`min-w-0 flex-1 bg-transparent px-3 py-2 font-display outline-none ${inputClassName}`.trim()}
      />
    </div>
  );
}

export default function SlugInput(props: SlugInputProps) {
  return <PrefixedInput prefix="/" {...props} />;
}
