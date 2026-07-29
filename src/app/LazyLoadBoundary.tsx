import { Component, createRef, type ReactNode, useLayoutEffect, useRef } from "react";

type FocusOnMountProps = {
  children: ReactNode;
  targetSelector: string;
};

export function FocusOnMount({ children, targetSelector }: FocusOnMountProps) {
  useLayoutEffect(() => {
    document.querySelector<HTMLElement>(targetSelector)?.focus();
  }, [targetSelector]);
  return children;
}

export function LazyLoadFocusFallback({ label }: { label: string }) {
  const statusRef = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    statusRef.current?.focus();
  }, []);

  return (
    <section
      aria-label={`Loading ${label}`}
      className="focus-rail focus-rail-load-state"
      ref={statusRef}
      role="status"
      tabIndex={-1}
    >
      Loading {label}…
    </section>
  );
}

type LazyLoadBoundaryProps = {
  children: ReactNode;
  label: string;
  onReload: () => void;
};

type LazyLoadBoundaryState = {
  failed: boolean;
};

export class LazyLoadBoundary extends Component<
  LazyLoadBoundaryProps,
  LazyLoadBoundaryState
> {
  state: LazyLoadBoundaryState = { failed: false };
  private readonly reloadRef = createRef<HTMLButtonElement>();

  static getDerivedStateFromError(): LazyLoadBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error(`Could not load the ${this.props.label}.`, error);
  }

  componentDidMount() {
    this.reloadRef.current?.focus();
  }

  componentDidUpdate(
    _previousProps: LazyLoadBoundaryProps,
    previousState: LazyLoadBoundaryState,
  ) {
    if (!previousState.failed && this.state.failed) this.reloadRef.current?.focus();
  }

  render() {
    if (this.state.failed) {
      return (
        <section className="focus-rail focus-rail-load-state" role="alert">
          <p>The {this.props.label} could not be loaded.</p>
          <button ref={this.reloadRef} type="button" onClick={this.props.onReload}>
            Reload Xiao
          </button>
        </section>
      );
    }
    return this.props.children;
  }
}
