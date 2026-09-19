interface Props {
  className?: string;
}

export default function Logo({ className = "w-6 h-6" }: Props) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <rect width="32" height="32" rx="8" className="fill-app stroke-border" />
      <path d="M7 16c2-8 4 8 6 0s4 8 6 0 4 8 6 0" fill="none" className="stroke-accent" strokeWidth="2" strokeLinecap="round" />
      <circle cx="24" cy="10" r="2" className="fill-warning" />
    </svg>
  );
}
