import Markdown from 'react-markdown';

// Model output is presentation data: no raw HTML, remote media or local action URLs.
function externalUrl(value: string) {
  if (!/^https?:\/\//i.test(value)) return '';
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) ? url.href : '';
  } catch { return ''; }
}

export function AssistantMessage({ text }: { text: string }) {
  return <div className="m-assistant m-markdown">
    <Markdown skipHtml urlTransform={externalUrl} components={{
      a: ({ href, children }) => href
        ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
        : <span>{children}</span>,
      img: ({ alt }) => <span>{alt || '图片'}</span>,
    }}>{text}</Markdown>
  </div>;
}
