import appIcon from "../../src-tauri/icons/icon.png";

interface Props {
  className?: string;
}

export default function Logo({ className = "w-6 h-6" }: Props) {
  return <img src={appIcon} className={className} alt="" aria-hidden="true" />;
}
