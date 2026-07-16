import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { XiaoIcon } from "../../../components/icons/XiaoIcon";
import type { AgentQuestionRequest } from "../../../core/models/agent";

type DraftAnswer = {
  option: string | null;
  note: string;
};

type QuestionDockProps = {
  request: AgentQuestionRequest;
  onResolve: (requestId: number | string, answers: Record<string, string[]>) => Promise<boolean>;
};

const emptyAnswer = (): DraftAnswer => ({ option: null, note: "" });

export function QuestionDock({ request, onResolve }: QuestionDockProps) {
  const [questionIndex, setQuestionIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, DraftAnswer>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  const focusTarget = useRef<HTMLElement | null>(null);
  const question = request.questions[questionIndex];
  const answer = answers[question.id] ?? emptyAnswer();
  const finalQuestion = questionIndex === request.questions.length - 1;
  const answered = Boolean(answer.option || answer.note.trim());
  const answeredCount = request.questions.filter((item) => {
    const value = answers[item.id];
    return Boolean(value?.option || value?.note.trim());
  }).length;
  const autoResolveAt = request.autoResolutionMs == null
    ? null
    : request.receivedAt + request.autoResolutionMs;
  const autoResolveSeconds = autoResolveAt == null
    ? null
    : Math.max(0, Math.ceil((autoResolveAt - now) / 1_000));

  useEffect(() => {
    if (autoResolveAt == null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [autoResolveAt]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => focusTarget.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [question.id]);

  const updateAnswer = (patch: Partial<DraftAnswer>) => {
    setAnswers((current) => ({
      ...current,
      [question.id]: { ...(current[question.id] ?? emptyAnswer()), ...patch },
    }));
    setError(null);
  };

  const submit = async () => {
    if (submitting) return;
    const payload: Record<string, string[]> = {};
    for (const item of request.questions) {
      const value = answers[item.id];
      if (!value) continue;
      const values = [
        value.option,
        value.note.trim() ? `user_note: ${value.note.trim()}` : null,
      ].filter((entry): entry is string => Boolean(entry));
      if (values.length) payload[item.id] = values;
    }

    setSubmitting(true);
    setError(null);
    if (!(await onResolve(request.requestId, payload))) {
      setSubmitting(false);
      setError("Xiao could not send this answer. Try again.");
    }
  };

  const dismiss = async () => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    if (!(await onResolve(request.requestId, {}))) {
      setSubmitting(false);
      setError("Xiao could not dismiss this question. Try again.");
    }
  };

  const continueFlow = () => {
    if (!answered || submitting) return;
    if (finalQuestion) {
      const firstUnanswered = request.questions.findIndex((item) => {
        const value = answers[item.id];
        return !value?.option && !value?.note.trim();
      });
      if (firstUnanswered >= 0) {
        setQuestionIndex(firstUnanswered);
        setError("Answer each question before sending, or skip the request.");
        return;
      }
      void submit();
      return;
    }
    setQuestionIndex((current) => current + 1);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!(event.ctrlKey || event.metaKey) || event.key !== "Enter") return;
    event.preventDefault();
    continueFlow();
  };

  return (
    <div
      className="question-dock"
      role="dialog"
      aria-modal={false}
      aria-labelledby="question-dock-title"
      onKeyDown={onKeyDown}
    >
      <header className="question-dock__header">
        <span className="question-dock__signal"><XiaoIcon name="approval" size={15} /></span>
        <div>
          <small>{question.header || "Input requested"}</small>
          <strong id="question-dock-title">Xiao needs your decision</strong>
        </div>
        <span className="question-dock__count">
          {questionIndex + 1}<i>/</i>{request.questions.length}
        </span>
      </header>

      {request.questions.length > 1 ? (
        <div className="question-dock__progress" aria-label={`${answeredCount} questions answered`}>
          {request.questions.map((item, index) => (
            <button
              className={`${index === questionIndex ? "is-active" : ""} ${
                answers[item.id]?.option || answers[item.id]?.note.trim() ? "is-answered" : ""
              }`}
              type="button"
              aria-label={`Open question ${index + 1}`}
              key={item.id}
              disabled={submitting}
              onClick={() => setQuestionIndex(index)}
            />
          ))}
        </div>
      ) : null}

      <div className="question-dock__body">
        <h2>{question.question}</h2>
        {question.options.length ? (
          <div className="question-dock__options" role="radiogroup" aria-label={question.question}>
            {question.options.map((option, optionIndex) => {
              const selected = answer.option === option.label;
              return (
                <button
                  className={selected ? "is-selected" : undefined}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={submitting}
                  key={`${optionIndex}-${option.label}`}
                  ref={optionIndex === 0 ? (node) => { focusTarget.current = node; } : undefined}
                  onClick={() => updateAnswer({ option: option.label })}
                >
                  <span><i /></span>
                  <div><strong>{option.label}</strong><small>{option.description}</small></div>
                  {selected ? <XiaoIcon name="check" size={14} /> : null}
                </button>
              );
            })}
          </div>
        ) : null}

        {question.isOther || !question.options.length ? (
          <label className="question-dock__note">
            <span>{question.options.length ? "Add context or write your own answer" : "Your answer"}</span>
            {question.isSecret ? (
              <input
                type="password"
                ref={(node) => { if (!question.options.length) focusTarget.current = node; }}
                value={answer.note}
                disabled={submitting}
                placeholder="Sensitive answer"
                onChange={(event) => updateAnswer({ note: event.target.value })}
              />
            ) : (
              <textarea
                rows={2}
                ref={(node) => { if (!question.options.length) focusTarget.current = node; }}
                value={answer.note}
                disabled={submitting}
                placeholder={question.options.length ? "Optional note" : "Type your answer"}
                onChange={(event) => updateAnswer({ note: event.target.value })}
              />
            )}
          </label>
        ) : null}
        {error ? <p className="question-dock__error" role="alert">{error}</p> : null}
      </div>

      <footer className="question-dock__footer">
        <div>
          <button className="button button--quiet" type="button" disabled={submitting} onClick={() => void dismiss()}>
            Skip
          </button>
          {autoResolveSeconds != null ? <small>Auto-resolves in {autoResolveSeconds}s</small> : null}
        </div>
        <div>
          {questionIndex > 0 ? (
            <button className="button button--quiet" type="button" disabled={submitting} onClick={() => setQuestionIndex((current) => current - 1)}>
              Back
            </button>
          ) : null}
          <button className="button button--primary" type="button" disabled={!answered || submitting} onClick={continueFlow}>
            {submitting ? "Sending..." : finalQuestion ? "Send answer" : "Continue"}
          </button>
        </div>
      </footer>
    </div>
  );
}
