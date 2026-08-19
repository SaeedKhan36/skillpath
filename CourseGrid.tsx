import { Component, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { addPropertyControls, ControlType } from "framer"

// --- Config -----------------------------------------------------------------

const API_BASE = "https://syncsphere-hiv6.onrender.com"
const COURSES_URL = `${API_BASE}/assignment/course-data`
const COUNTRY_URL = `${API_BASE}/assignment/country-code`

// The API fails on purpose roughly 1 in 3 calls. One attempt would show an
// error state to a third of visitors, which is not a real product. Three
// attempts drops that to ~4%, and anything that still fails gets a proper
// error state with a manual retry rather than a silent blank section.
const MAX_ATTEMPTS = 3

// It is hosted on a free tier that cold-starts, so the first call can be slow.
// Long enough to survive a cold boot, short enough that a dead API does not
// spin forever.
const TIMEOUT_MS = 20000

const FALLBACK_COUNTRY = "IN"

// Worst case before the error state appears is TIMEOUT_MS * MAX_ATTEMPTS plus
// backoff — around a minute. Long before that, the shimmer should stop being
// the only thing happening.
const SLOW_AFTER_MS = 6000

// --- Networking -------------------------------------------------------------

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type FailureReason = "offline" | "timeout" | "server"

/** An Error that remembers why it failed, so the UI can say something useful. */
function failure(reason: FailureReason, message: string) {
    const error = new Error(message) as Error & { reason: FailureReason }
    error.reason = reason
    return error
}

/** Anything untagged is treated as a server problem, which is the safe default. */
function reasonOf(error: unknown): FailureReason {
    return (error as { reason?: FailureReason })?.reason ?? "server"
}

/**
 * GET a URL as JSON, aborting on either our own timeout or the caller's signal.
 * Only GET is ever sent — every other method on this API returns 405.
 */
async function getJson(url: string, outerSignal: AbortSignal) {
    const controller = new AbortController()
    // Our timeout and the caller's cleanup abort the same controller, so this
    // flag is the only way to tell afterwards which one of them fired.
    let timedOut = false
    const timer = setTimeout(() => {
        timedOut = true
        controller.abort()
    }, TIMEOUT_MS)
    const forwardAbort = () => controller.abort()
    outerSignal.addEventListener("abort", forwardAbort)

    try {
        const response = await fetch(url, {
            method: "GET",
            signal: controller.signal,
        })

        // fetch only rejects on network failure, so a 404 or 500 arrives here
        // as a resolved promise. Turning it into a throw is what lets both
        // failure modes share one catch block.
        if (!response.ok) {
            throw failure("server", `${url} responded ${response.status}`)
        }

        return await response.json()
    } catch (error) {
        // An unmount or a superseded request is not a failure to report.
        if (outerSignal.aborted) throw error
        if (timedOut) throw failure("timeout", `${url} timed out`)
        if (typeof navigator !== "undefined" && navigator.onLine === false) {
            throw failure("offline", "the browser is offline")
        }
        throw error
    } finally {
        clearTimeout(timer)
        outerSignal.removeEventListener("abort", forwardAbort)
    }
}

/** getJson with bounded retries and a small backoff between attempts. */
async function getJsonWithRetry(url: string, signal: AbortSignal) {
    let lastError: unknown

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            return await getJson(url, signal)
        } catch (error) {
            // An unmounted component is not a failure worth retrying.
            if (signal.aborted) throw error
            // Neither is a disconnected browser — three attempts would spend
            // 1.2s of backoff reaching a conclusion we already have.
            if (reasonOf(error) === "offline") throw error
            lastError = error
            if (attempt < MAX_ATTEMPTS) await wait(attempt * 400)
        }
    }

    throw lastError
}

// --- Money ------------------------------------------------------------------

/**
 * Each country carries its own price field, so the currency and the field it
 * reads can never drift apart. Pairing Rs with priceUsdCents is not a mistake
 * this table lets you make.
 */
const CURRENCIES = {
    IN: { locale: "en-IN", currency: "INR", field: "pricePaise" },
    US: { locale: "en-US", currency: "USD", field: "priceUsdCents" },
} as const

type CountryCode = keyof typeof CURRENCIES

/** The one place a country code is checked. Used by both the hook and formatPrice. */
function isSupportedCountry(value: unknown): value is CountryCode {
    return value === "IN" || value === "US"
}

function formatPrice(course: any, country: string) {
    const config = isSupportedCountry(country)
        ? CURRENCIES[country]
        : CURRENCIES[FALLBACK_COUNTRY]

    const minorUnits = course?.[config.field]

    // A flaky API can drop or mangle the field, and "Rs NaN" on a card is worse
    // than admitting we do not have the number.
    if (typeof minorUnits !== "number" || !Number.isFinite(minorUnits)) {
        return "Price unavailable"
    }

    // Both fields are in the currency's minor unit — paise and cents — so both
    // divide by 100. 199900 paise is Rs 1,999.00, not Rs 1,99,900.
    const majorUnits = minorUnits / 100

    // Both currencies always show their minor unit, so 199900 paise reads as
    // Rs 1,999.00 and 1050 as Rs 10.50. Pinning both ends of the range stops
    // Intl dropping a trailing zero on a whole amount.
    return new Intl.NumberFormat(config.locale, {
        style: "currency",
        currency: config.currency,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    }).format(majorUnits)
}

// --- Failure copy -----------------------------------------------------------

const FAILURE_COPY = {
    offline: {
        title: "You appear to be offline.",
        body: "Check your connection and try again.",
    },
    timeout: {
        title: "This is taking longer than usual.",
        body: "The server may be waking up. Give it another go.",
    },
    server: {
        title: "We couldn't load the courses.",
        body: "The catalogue didn't respond. It's usually back within a moment.",
    },
}

// --- Data hook --------------------------------------------------------------

type Status = "loading" | "error" | "empty" | "ready"

function useCourseData() {
    const [status, setStatus] = useState<Status>("loading")
    const [failureReason, setFailureReason] = useState<FailureReason>("server")
    const [courses, setCourses] = useState<any[]>([])
    const [detectedCountry, setDetectedCountry] = useState(FALLBACK_COUNTRY)
    const [countryFailed, setCountryFailed] = useState(false)
    const [countryRetrying, setCountryRetrying] = useState(false)
    const [reloadToken, setReloadToken] = useState(0)
    const [countryToken, setCountryToken] = useState(0)

    const retry = useCallback(() => setReloadToken((n) => n + 1), [])
    const retryCountry = useCallback(() => setCountryToken((n) => n + 1), [])

    useEffect(() => {
        const controller = new AbortController()
        const { signal } = controller

        async function load() {
            setStatus("loading")
            setCountryFailed(false)

            // allSettled, not all: the two calls fail independently, and a
            // dead country lookup must not take the course list down with it.
            // Both run regardless of the Region control — that control picks
            // which answer to display, it does not decide what to fetch.
            const [coursesResult, countryResult] = await Promise.allSettled([
                getJsonWithRetry(COURSES_URL, signal),
                getJsonWithRetry(COUNTRY_URL, signal),
            ])

            if (signal.aborted) return

            const detected =
                countryResult.status === "fulfilled"
                    ? countryResult.value?.country_code
                    : undefined

            // Only overwrite the country when the lookup actually told us
            // something. Falling back on every failure would throw away a region
            // we already confirmed, flipping a US visitor's prices to rupees on
            // the first retry. The initial state is already the fallback, so a
            // first load that fails still lands on IN.
            if (isSupportedCountry(detected)) {
                setDetectedCountry(detected)
                setCountryFailed(false)
            } else {
                setCountryFailed(true)
            }

            if (coursesResult.status === "rejected") {
                setCourses([])
                setFailureReason(reasonOf(coursesResult.reason))
                setStatus("error")
                return
            }

            // A 200 carrying something that is not an array is a broken
            // response, not an empty catalogue. Collapsing the two would tell
            // the visitor "no courses yet", which is not what happened.
            if (!Array.isArray(coursesResult.value)) {
                setCourses([])
                setFailureReason("server")
                setStatus("error")
                return
            }

            const list = coursesResult.value
            setCourses(list)
            setStatus(list.length === 0 ? "empty" : "ready")
        }

        load()
        return () => controller.abort()
    }, [reloadToken])

    // Retrying just the region. The cards are already on screen by the time this
    // button exists, so there is nothing left to synchronise and no reason to
    // refetch the courses or drop back to a skeleton.
    useEffect(() => {
        // Token 0 is the initial mount, which the effect above already handles.
        if (countryToken === 0) return

        const controller = new AbortController()
        const { signal } = controller
        setCountryRetrying(true)

        getJsonWithRetry(COUNTRY_URL, signal)
            .then((data) => {
                if (signal.aborted) return
                if (isSupportedCountry(data?.country_code)) {
                    setDetectedCountry(data.country_code)
                    setCountryFailed(false)
                }
            })
            // A failed retry needs no handling: the notice is already showing
            // and the price is already on its last known good currency.
            .catch(() => {})
            .finally(() => {
                if (!signal.aborted) setCountryRetrying(false)
            })

        return () => controller.abort()
    }, [countryToken])

    return {
        status,
        failureReason,
        courses,
        detectedCountry,
        countryFailed,
        countryRetrying,
        retry,
        retryCountry,
    }
}

// --- Responsive columns -----------------------------------------------------

/**
 * Every responsive decision in the section reads off this one table, so columns,
 * padding and heading size can never disagree about what size we are at. Widths
 * are outer widths and line up with Framer's default breakpoint frames — 1200
 * desktop, 810 tablet, 390 phone.
 */
const LAYOUTS = [
    { minWidth: 960, columns: 3, compact: false },
    { minWidth: 640, columns: 2, compact: false },
    { minWidth: 0, columns: 1, compact: true },
]

function layoutForWidth(width: number) {
    return LAYOUTS.find((layout) => width >= layout.minWidth) ?? LAYOUTS[LAYOUTS.length - 1]
}

// useLayoutEffect measures before the browser paints, but warns when there is no
// DOM to measure. Framer statically renders published pages, so fall back to
// useEffect on the server, where the measurement is meaningless anyway.
const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect

/**
 * Layout comes from the container's width, not the viewport's. Framer's canvas
 * breakpoints resize the frame the component sits in while the browser window
 * stays the same, so a CSS media query would report the wrong size in the
 * editor. ResizeObserver measures the thing that actually changed.
 */
function useContainerLayout(ref: { current: HTMLDivElement | null }) {
    const [layout, setLayout] = useState(LAYOUTS[0])

    useIsomorphicLayoutEffect(() => {
        const element = ref.current
        if (!element) return

        const observer = new ResizeObserver(([entry]) => {
            // The border box, not contentRect. contentRect excludes padding, and
            // this measurement decides the padding — feeding one into the other
            // oscillates forever around a breakpoint. Border-box width is just
            // the parent's width, so nothing we change here can change it back.
            const width =
                entry.borderBoxSize?.[0]?.inlineSize ??
                element.getBoundingClientRect().width

            setLayout(layoutForWidth(width))
        })

        observer.observe(element)
        return () => observer.disconnect()
    }, [ref])

    return layout
}

/**
 * True once a load has been running long enough to be worth acknowledging.
 * Resets on every status change, so a fast reload never inherits a stale flag.
 */
function useSlowLoad(isLoading: boolean) {
    const [slow, setSlow] = useState(false)

    useEffect(() => {
        if (!isLoading) {
            setSlow(false)
            return
        }
        const timer = setTimeout(() => setSlow(true), SLOW_AFTER_MS)
        return () => clearTimeout(timer)
    }, [isLoading])

    return slow
}

// --- Error boundary ---------------------------------------------------------

/**
 * Wraps only the card list. Every field is already read defensively, so this
 * should never fire — but if a card does throw, the blank page would otherwise
 * take the hero and footer with it.
 */
class CourseListBoundary extends Component<
    { onRetry: () => void; children: any },
    { failed: boolean }
> {
    state = { failed: false }

    static getDerivedStateFromError() {
        return { failed: true }
    }

    componentDidCatch(error: unknown) {
        // This is not supposed to happen, so the reason needs to reach somewhere
        // a developer will actually look.
        console.error("CourseGrid failed while rendering the course list", error)
    }

    render() {
        if (!this.state.failed) return this.props.children

        return (
            <div className="sp-message" role="alert">
                <p className="sp-message-title">Something went wrong displaying the courses.</p>
                <p className="sp-message-body">
                    The rest of the page is fine. Reloading the list usually clears it.
                </p>
                <button
                    className="sp-button"
                    onClick={() => {
                        // Clearing the flag alone would rerender the same bad
                        // payload straight back into the same throw.
                        this.setState({ failed: false })
                        this.props.onRetry()
                    }}
                >
                    Try again
                </button>
            </div>
        )
    }
}

/**
 * One card, deliberately its own component. If the fields were read inline in
 * CourseGrid's map, that read would happen while CourseGrid builds the children
 * it hands to the boundary — above the boundary, where nothing catches it. As a
 * separate component the reads happen in a descendant's render, which is what an
 * error boundary can actually catch.
 */
function CourseCard({
    course,
    country,
    linkBase,
}: {
    course: any
    country: string
    linkBase: string
}) {
    const code = typeof course?.courseCode === "string" ? course.courseCode : ""

    // No base configured means no destination exists yet, so the card stays a
    // plain article rather than linking somewhere that 404s. A card that looks
    // clickable and goes nowhere is worse than one that does not.
    const href = linkBase && code ? `${linkBase}${code}` : ""

    const content = (
        <>
            <div className="sp-tags">
                {course?.mainCategory ? (
                    <span className="sp-badge">{course.mainCategory}</span>
                ) : null}
                {course?.refundable === true ? (
                    <span className="sp-badge sp-badge-refund">Refundable</span>
                ) : null}
            </div>

            <h3 className="sp-card-title">{course?.courseName ?? "Untitled course"}</h3>

            {course?.description ? (
                <p className="sp-card-description">{course.description}</p>
            ) : null}

            <p className="sp-price">{formatPrice(course, country)}</p>
        </>
    )

    // The anchor replaces the article rather than nesting inside it, so the
    // whole card is the hit target instead of just the text within it.
    if (href) {
        return (
            <a className="sp-card sp-card-link" href={href}>
                {content}
            </a>
        )
    }

    return <article className="sp-card">{content}</article>
}

// --- Component --------------------------------------------------------------

// Declared once and used by both the component and the property controls, so
// the panel and the code can never disagree about what the defaults are.
const DEFAULTS = {
    heading: "Courses built to be finished",
    subheading: "Practical programs you can start today.",
    accent: "#5B4BFF",
    limitCards: false,
    maxCourses: 6,
    region: "auto",
    courseLinkBase: "",
}

/**
 * @framerSupportedLayoutWidth any
 * @framerSupportedLayoutHeight auto
 * @framerIntrinsicWidth 1200
 * @framerIntrinsicHeight 700
 */
export default function CourseGrid(props: any) {
    const {
        heading = DEFAULTS.heading,
        subheading = DEFAULTS.subheading,
        accent = DEFAULTS.accent,
        limitCards = DEFAULTS.limitCards,
        maxCourses = DEFAULTS.maxCourses,
        region = DEFAULTS.region,
        courseLinkBase = DEFAULTS.courseLinkBase,
        style,
    } = props

    const containerRef = useRef<HTMLDivElement>(null)
    const { columns, compact } = useContainerLayout(containerRef)
    const {
        status,
        failureReason,
        courses,
        detectedCountry,
        countryFailed,
        countryRetrying,
        retry,
        retryCountry,
    } = useCourseData()

    const slowLoad = useSlowLoad(status === "loading")

    // The Region control only picks which answer to show. Pinning it is a
    // display choice, so it never triggers a fetch or a loading state.
    const country = region === "auto" ? detectedCountry : region

    // The API returns 5 to 10 courses, so the cap has to clamp a list whose
    // length we never know ahead of time. slice() past the end is a no-op, so a
    // cap larger than the response needs no special case.
    const visibleCourses = useMemo(
        () => (limitCards ? courses.slice(0, maxCourses) : courses),
        [courses, limitCards, maxCourses]
    )

    return (
        <div
            ref={containerRef}
            className={compact ? "sp-section sp-compact" : "sp-section"}
            style={{
                ...style,
                ["--accent" as any]: accent,
                ["--columns" as any]: columns,
                // One column would otherwise stretch a card to the full frame.
                // The grid is already margin-auto, so capping the variable both
                // caps and centres it.
                ["--grid-max-width" as any]: columns === 1 ? "480px" : "1160px",
            }}
        >
            <style>{CSS}</style>

            <header className="sp-header">
                <h2 className="sp-heading">{heading}</h2>
                {subheading ? <p className="sp-subheading">{subheading}</p> : null}
            </header>

            {/* The country call failed but the courses did not. Showing a price
                is better than showing none, so we fall back to rupees and say so
                instead of quietly risking the wrong currency. The retry only
                re-runs the region lookup, leaving the loaded cards alone. */}
            {status === "ready" && countryFailed && region === "auto" ? (
                <div className="sp-notice" role="status">
                    <span>We couldn't detect your region, so prices are shown in ₹.</span>
                    <button
                        className="sp-notice-button"
                        onClick={retryCountry}
                        disabled={countryRetrying}
                    >
                        {countryRetrying ? "Retrying…" : "Retry"}
                    </button>
                </div>
            ) : null}

            {status === "loading" ? (
                <>
                    <p className={slowLoad ? "sp-slow" : "sp-sr-only"} role="status">
                        {slowLoad
                            ? "Still loading — the server may be waking up."
                            : "Loading courses."}
                    </p>
                    <div className="sp-grid" aria-busy="true">
                    {/* Two rows of placeholders, so mobile does not scroll
                        through six full-width cards that are not there yet. */}
                    {Array.from({ length: columns * 2 }).map((_, index) => (
                        <div key={index} className="sp-card sp-skeleton-card">
                            <div className="sp-skeleton sp-skeleton-badge" />
                            <div className="sp-skeleton sp-skeleton-title" />
                            <div className="sp-skeleton sp-skeleton-line" />
                            <div className="sp-skeleton sp-skeleton-line sp-skeleton-short" />
                            <div className="sp-skeleton sp-skeleton-price" />
                        </div>
                    ))}
                    </div>
                </>
            ) : null}

            {status === "error" ? (
                <div className="sp-message" role="alert">
                    <p className="sp-message-title">
                        {(FAILURE_COPY[failureReason] ?? FAILURE_COPY.server).title}
                    </p>
                    <p className="sp-message-body">
                        {(FAILURE_COPY[failureReason] ?? FAILURE_COPY.server).body}
                    </p>
                    <button className="sp-button" onClick={retry}>
                        Try again
                    </button>
                </div>
            ) : null}

            {status === "empty" ? (
                <div className="sp-message" role="status">
                    <p className="sp-message-title">No courses yet.</p>
                    <p className="sp-message-body">
                        Nothing is published right now. Check back soon.
                    </p>
                    <button className="sp-button" onClick={retry}>
                        Refresh
                    </button>
                </div>
            ) : null}

            {status === "ready" ? (
                <CourseListBoundary onRetry={retry}>
                <div className="sp-grid">
                    {visibleCourses.map((course, index) => (
                        <CourseCard
                            key={course?.courseCode ?? index}
                            course={course}
                            country={country}
                            linkBase={courseLinkBase}
                        />
                    ))}
                </div>
                </CourseListBoundary>
            ) : null}
        </div>
    )
}

// --- Styles -----------------------------------------------------------------

const CSS = `
.sp-section {
    box-sizing: border-box;
    width: 100%;
    padding: 72px 32px;
    font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    color: #12121a;
}
.sp-section *, .sp-section *::before, .sp-section *::after { box-sizing: border-box; }

.sp-header { max-width: 640px; margin: 0 auto 40px; text-align: center; }
.sp-heading { margin: 0; font-size: 40px; line-height: 1.15; letter-spacing: -0.02em; font-weight: 600; }
.sp-subheading { margin: 12px 0 0; font-size: 17px; line-height: 1.5; color: #62626f; }

.sp-notice {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: center;
    gap: 4px 10px;
    max-width: var(--grid-max-width);
    margin: 0 auto 24px;
    padding: 10px 14px;
    border-radius: 10px;
    background: #fff7e6;
    border: 1px solid #ffe0a3;
    color: #7a5a12;
    font-size: 14px;
    text-align: center;
}

/* A text button, not a second pill. The error state's button is the primary
   action on this section and this must not compete with it. */
.sp-notice-button {
    padding: 0;
    border: none;
    background: none;
    color: inherit;
    font: inherit;
    font-weight: 600;
    text-decoration: underline;
    cursor: pointer;
}
.sp-notice-button:disabled {
    cursor: default;
    opacity: 0.6;
    text-decoration: none;
}

.sp-grid {
    display: grid;
    /* minmax(0, 1fr) rather than 1fr: a 1fr track has an auto minimum, so one
       long unbreakable word would push the whole grid wider than its container. */
    grid-template-columns: repeat(var(--columns), minmax(0, 1fr));
    gap: 20px;
    max-width: var(--grid-max-width);
    margin: 0 auto;
    align-items: stretch;
}

.sp-card {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 24px;
    border-radius: 16px;
    border: 1px solid #e8e8ef;
    background: #ffffff;
    transition: transform 0.18s ease, box-shadow 0.18s ease, border-color 0.18s ease;
}
.sp-card:hover {
    transform: translateY(-2px);
    border-color: var(--accent);
    box-shadow: 0 12px 28px rgba(18, 18, 26, 0.08);
}

.sp-tags { display: flex; flex-wrap: wrap; gap: 8px; }
.sp-badge {
    padding: 4px 10px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--accent) 10%, transparent);
    color: var(--accent);
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.01em;
}
.sp-badge-refund { background: #e8f7ee; color: #1c7c46; }

/* Names wrap rather than truncate — the name is what a learner scans for. The
   grid stretches cards to equal height anyway, and the price is bottom-pinned,
   so a two-line name costs nothing but the description's start line. */
.sp-card-title {
    margin: 0;
    font-size: 19px;
    line-height: 1.3;
    font-weight: 600;
    overflow-wrap: break-word;
}

/* Two lines, then an ellipsis. max-height is the fallback for anything without
   line-clamp, expressed in em so it tracks this element's own font-size instead
   of going stale the moment the type scale changes. */
.sp-card-description {
    margin: 0;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    overflow: hidden;
    font-size: 15px;
    line-height: 1.5;
    max-height: calc(2 * 1.5em);
    overflow-wrap: break-word;
    color: #62626f;
}

/* Pushes the price to the bottom so every card in a row ends the same way,
   whatever the description length. */
.sp-price { margin: auto 0 0; padding-top: 4px; font-size: 20px; font-weight: 600; }

.sp-message {
    max-width: min(520px, var(--grid-max-width));
    margin: 0 auto;
    padding: 40px 24px;
    text-align: center;
    border: 1px dashed #d8d8e2;
    border-radius: 16px;
}
.sp-message-title { margin: 0; font-size: 18px; font-weight: 600; }
.sp-message-body { margin: 8px 0 20px; font-size: 15px; color: #62626f; }

.sp-button {
    padding: 10px 22px;
    border: none;
    border-radius: 999px;
    background: var(--accent);
    color: #ffffff;
    font-size: 15px;
    font-weight: 600;
    font-family: inherit;
    cursor: pointer;
}
.sp-button:hover { opacity: 0.88; }

/* A card that is a link should not inherit link colour or underline — it is a
   card, not a run of text. */
.sp-card-link {
    text-decoration: none;
    color: inherit;
}

/* Hover is mouse-only, so without this a keyboard user has no idea where they
   are. :focus-visible rather than :focus, so a mouse click does not leave a
   ring behind. The offset puts the ring on the page background, which keeps it
   visible even on the accent-filled button. */
.sp-button:focus-visible,
.sp-notice-button:focus-visible,
.sp-card-link:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 3px;
}

/* Windows high contrast mode drops author colours, so the ring needs a
   system-coloured fallback or it disappears entirely. */
@media (forced-colors: active) {
    .sp-button:focus-visible,
    .sp-notice-button:focus-visible,
    .sp-card-link:focus-visible {
        outline-color: Highlight;
    }
}

/* Visible only to screen readers, so the loading announcement does not depend
   on anyone being able to read a shimmer. */
.sp-sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
}

.sp-slow {
    max-width: var(--grid-max-width);
    margin: 0 auto 20px;
    text-align: center;
    font-size: 14px;
    color: #62626f;
}

/* Matched to a real card so the grid does not jolt when data lands. */
.sp-skeleton-card { pointer-events: none; min-height: 205px; }
.sp-skeleton {
    border-radius: 6px;
    background: linear-gradient(90deg, #eeeef3 25%, #f7f7fa 37%, #eeeef3 63%);
    background-size: 400% 100%;
    animation: sp-shimmer 1.4s ease infinite;
}
.sp-skeleton-badge { width: 96px; height: 20px; border-radius: 999px; }
.sp-skeleton-title { width: 70%; height: 20px; }
.sp-skeleton-line { width: 100%; height: 13px; }
.sp-skeleton-short { width: 60%; }
.sp-skeleton-price { width: 88px; height: 22px; margin-top: 8px; }

@keyframes sp-shimmer {
    0% { background-position: 100% 50%; }
    100% { background-position: 0 50%; }
}

/* Someone on prefers-reduced-motion should not get a pulsing grid. */
@media (prefers-reduced-motion: reduce) {
    .sp-skeleton { animation: none; }
    .sp-card { transition: none; }
}

/* Driven by the measured container, not a viewport media query. A media query
   would keep desktop padding at Framer's mobile breakpoint, where the frame is
   narrow but the browser window is not. */
.sp-compact { padding: 56px 20px; }
.sp-compact .sp-heading { font-size: 30px; }
.sp-compact .sp-header { margin-bottom: 32px; }
.sp-compact .sp-grid { gap: 16px; }
`

// --- Property controls ------------------------------------------------------

addPropertyControls(CourseGrid, {
    heading: {
        type: ControlType.String,
        title: "Heading",
        defaultValue: DEFAULTS.heading,
        description: "The headline above the cards.",
    },
    subheading: {
        type: ControlType.String,
        title: "Subheading",
        defaultValue: DEFAULTS.subheading,
        displayTextArea: true,
        description: "Leave empty to hide it.",
    },
    accent: {
        type: ControlType.Color,
        title: "Accent",
        defaultValue: DEFAULTS.accent,
        description: "Category badges, card hover, and buttons.",
    },
    limitCards: {
        type: ControlType.Boolean,
        title: "Limit cards",
        defaultValue: DEFAULTS.limitCards,
        description: "Off shows every course the API returns.",
    },
    maxCourses: {
        type: ControlType.Number,
        title: "Show at most",
        defaultValue: DEFAULTS.maxCourses,
        min: 1,
        max: 12,
        step: 1,
        displayStepper: true,
        // Framer's idiom for a dependent control: the number only exists once
        // limiting is on, so no value has to double as "no limit".
        hidden: (props: any) => !props.limitCards,
    },
    region: {
        type: ControlType.Enum,
        title: "Region",
        defaultValue: DEFAULTS.region,
        options: ["auto", "IN", "US"],
        optionTitles: ["Auto (from API)", "India \u20b9", "United States $"],
        description: "Auto is what ships. The other two are for previewing prices.",
    },
    courseLinkBase: {
        type: ControlType.String,
        title: "Card link",
        defaultValue: DEFAULTS.courseLinkBase,
        placeholder: "https://example.com/courses/",
        description:
            "Base URL. The course code is appended to it. Empty leaves cards unlinked.",
    },
})
