// When a page throws while drawing, or a page loaded on demand can't be fetched (a tab left open
// across a deploy asks for a file the new version doesn't have), React would otherwise blank the
// whole dashboard. This catches it and offers a reload, which fetches the new version. React
// only offers this as a class component: https://react.dev/reference/react/Component#catching-rendering-errors-with-an-error-boundary
import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button, EmptyState } from "./components.tsx";
import { RotateCcw, TriangleAlert } from "./icons.ts";

interface State {
  failed: boolean;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // The browser's console only: nothing about a caller is in a rendering error's message.
    console.error("A page failed to draw", error, info.componentStack);
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="card">
        <EmptyState
          icon={TriangleAlert}
          headingLevel={1}
          title="This page didn't load"
          action={
            <Button icon={RotateCcw} onClick={() => window.location.reload()}>
              Reload the page
            </Button>
          }
        >
          AnswerMate may have just been updated. Reloading fetches the new version.
        </EmptyState>
      </div>
    );
  }
}
