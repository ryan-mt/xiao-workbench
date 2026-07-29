import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MessageActions } from "./MessageActions";

describe("MessageActions", () => {
  it("renders timestamps at the Unix epoch", () => {
    const markup = renderToStaticMarkup(<MessageActions text="Hello" createdAt={0} />);

    expect(markup).toContain("<time");
    expect(markup.toLowerCase()).toContain('datetime="1970-01-01t00:00:00.000z"');
  });
});
