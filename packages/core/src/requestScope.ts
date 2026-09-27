/** Only unambiguous social greetings take the zero-tool path; substantive requests keep normal routing. */
export function isGreeting(input: string) {
  return /^(?:hi|hey|hello|hiya|howdy|good (?:morning|afternoon|evening))(?:\s+(?:there|again|everyone|folks|team))?[\s!.?,]*$/i.test(
    input.trim(),
  );
}
