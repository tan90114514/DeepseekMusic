interface TransportIconProps {
  className?: string
}

export function PlayTransportIcon({ className }: TransportIconProps): React.JSX.Element {
  return (
    <svg
      className={`transport-icon transport-icon-play ${className ?? ''}`}
      viewBox="256 221.4867 511.4182 581.0265"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M744.727273 551.563636L325.818182 795.927273c-30.254545 18.618182-69.818182-4.654545-69.818182-39.563637v-488.727272c0-34.909091 39.563636-58.181818 69.818182-39.563637l418.909091 244.363637c30.254545 16.290909 30.254545 62.836364 0 79.127272z"
        fill="currentColor"
      />
    </svg>
  )
}

export function PauseTransportIcon({ className }: TransportIconProps): React.JSX.Element {
  return (
    <svg
      className={`transport-icon transport-icon-pause ${className ?? ''}`}
      viewBox="302.5455 244.3636 418.9091 535.2727"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M442.181818 709.818182c0 37.236364-30.254545 69.818182-69.818182 69.818182s-69.818182-30.254545-69.818181-69.818182v-395.636364c0-37.236364 30.254545-69.818182 69.818181-69.818182s69.818182 30.254545 69.818182 69.818182v395.636364z m279.272727 0c0 37.236364-30.254545 69.818182-69.818181 69.818182s-69.818182-30.254545-69.818182-69.818182v-395.636364c0-37.236364 30.254545-69.818182 69.818182-69.818182s69.818182 30.254545 69.818181 69.818182v395.636364z"
        fill="currentColor"
      />
    </svg>
  )
}
