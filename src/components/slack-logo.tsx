/**
 * The four-color Slack mark, inline SVG. Kept here (not pulled in as an
 * external package) because (a) we want exact brand colors at any size, and
 * (b) bringing in a third-party icon package for one logo is overkill.
 *
 * Brand colors per Slack's media kit:
 *   #36C5F0 (blue)  #2EB67D (green)  #ECB22E (yellow)  #E01E5A (red)
 */
export function SlackLogo({
  className,
  title = "Slack",
}: {
  className?: string;
  title?: string;
}) {
  return (
    <svg
      viewBox="0 0 124 124"
      className={className}
      role="img"
      aria-label={title}
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M26 78a12 12 0 1 1-12-12h12v12zm6 0a12 12 0 1 1 24 0v30a12 12 0 1 1-24 0V78z"
        fill="#E01E5A"
      />
      <path
        d="M44 26a12 12 0 1 1 12-12v12H44zm0 6a12 12 0 1 1 0 24H14a12 12 0 1 1 0-24h30z"
        fill="#36C5F0"
      />
      <path
        d="M98 44a12 12 0 1 1 12 12H98V44zm-6 0a12 12 0 1 1-24 0V14a12 12 0 1 1 24 0v30z"
        fill="#2EB67D"
      />
      <path
        d="M80 98a12 12 0 1 1-12 12V98h12zm0-6a12 12 0 1 1 0-24h30a12 12 0 1 1 0 24H80z"
        fill="#ECB22E"
      />
    </svg>
  );
}
