// Hand-made decision cases (scripts/decide-bench.ts): AUTO router messages with the model, effort and new topic a
// person would pick, and 20-second talk chunks with the points of a list the speaker has started on.
import type { RouteInput } from '../../server/router.ts';

export type RouterCase = { input: Partial<RouteInput> & { text: string }; model: string; effort: string; newTopic?: boolean };
export const ROUTER: RouterCase[] = [
  { input: { text: 'thanks!' }, model: 'haiku', effort: 'low' },
  { input: { text: 'what port does the server run on?' }, model: 'haiku', effort: 'low' },
  { input: { text: 'rename the function getUser to fetchUser in api.ts' }, model: 'haiku', effort: 'low' },
  { input: { text: 'Fix the typo "recieve" in the README' }, model: 'haiku', effort: 'low' },
  { input: { text: 'Convert this to YAML: {"name":"web","port":8080,"replicas":2}' }, model: 'haiku', effort: 'low' },
  { input: { text: 'how are you doing today?' }, model: 'haiku', effort: 'low' },
  { input: { text: 'Update the version in package.json to 2.3.0 and commit it' }, model: 'sonnet', effort: 'low' },
  { input: { text: 'Summarize notes/meeting-2026-10-20.md in 5 bullets' }, model: 'sonnet', effort: 'medium' },
  { input: { text: 'Explain the difference between git rebase and git merge, and when I should use each' }, model: 'sonnet', effort: 'medium' },
  { input: { text: 'Add a --verbose flag to scripts/backup.sh that prints each file it copies' }, model: 'sonnet', effort: 'medium' },
  { input: { text: 'Install ripgrep and add it to the package list in the setup script' }, model: 'sonnet', effort: 'medium' },
  { input: { text: 'Write a regex that matches ISO 8601 dates like 2026-10-27' }, model: 'sonnet', effort: 'low' },
  { input: { text: 'Why does the server crash with ECONNRESET every time my phone wakes up? The log is in data/server.log' }, model: 'opus', effort: 'high' },
  { input: { text: 'Plan how we add multi-user support: login, keeping each user\'s data apart, and moving the existing data over' }, model: 'opus', effort: 'xhigh' },
  { input: { text: 'Move the routing code out of tab.ts and tabs.ts into its own module, update every caller and the tests' }, model: 'opus', effort: 'high' },
  { input: { text: 'Write the launch email for the new site to our 200 customers, warm but short' }, model: 'opus', effort: 'high' },
  { input: { text: 'The build fails on CI but passes on my machine. Find out why and fix it.' }, model: 'opus', effort: 'high' },
  { input: { text: 'Design a cache for the API with invalidation on writes. Compare two approaches and pick one.' }, model: 'opus', effort: 'xhigh' },
  { input: { text: 'Go through every test file, find the flaky ones and make them deterministic' }, model: 'opus', effort: 'high' },
  { input: { text: 'Review the login and passkey code for security holes' }, model: 'opus', effort: 'high' },
  // Mid-chat: the same work goes on, or something new starts.
  {
    input: { text: 'yes, go ahead', title: 'Fix flaky upload test', turns: 4, current: { model: 'opus', effort: 'high' }, lastReply: 'The upload test fails about one run in ten because it reads the folder before the write finishes. I can make the test wait on the write promise instead of a fixed sleep. Should I make that change?' },
    model: 'haiku', effort: 'low', newTopic: false,
  },
  {
    input: { text: 'also make it retry once if the disk is busy', title: 'Fix flaky upload test', turns: 5, current: { model: 'opus', effort: 'high' }, lastReply: 'Done: the test now awaits the write. It passed 50 runs in a row.' },
    model: 'sonnet', effort: 'medium', newTopic: false,
  },
  {
    input: { text: 'different thing: what is the capital of Australia?', title: 'Fix flaky upload test', turns: 6, current: { model: 'opus', effort: 'high' }, lastReply: 'Added one retry after 200 ms when the write fails with EBUSY. Tests pass.' },
    model: 'haiku', effort: 'low', newTopic: true,
  },
  {
    input: { text: 'Now let\'s plan the new billing page: what it shows, where the data comes from, and the API it needs', title: 'Fix flaky upload test', turns: 7, current: { model: 'haiku', effort: 'low' }, lastReply: 'Canberra.' },
    model: 'opus', effort: 'high', newTopic: true,
  },
];

export type PunchCase = { points: string[]; chunk: string; started: number[] };
export const HOME = ['Why I stopped paying for cloud storage', 'The old PC I turned into a server', 'Picking drives: parity or mirror', 'Installing the OS in ten minutes', 'Backups: the 3-2-1 rule', 'Remote access without opening ports', 'What it costs per month in power', 'Mistakes I made the first week'];
const MEALS = ['Shopping once for the whole week', 'Cooking grains in bulk', 'Roasting two trays of vegetables', 'One sauce that goes with everything', 'Containers and how long food keeps', 'Freezing portions for later', 'Keeping it from getting boring', 'The cost compared to takeout'];
export const PIANO = ['Why adults quit in the first month', 'Fifteen minutes a day beats two hours on Sunday', 'Reading notes or playing by ear', 'Picking a first song you actually like', 'Hands separately before hands together', 'Using a metronome without hating it', 'Recording yourself', 'When to get a teacher'];
const PITCH = ['The problem the client has today', 'What we do in the first week', 'A real example from a past client', 'How we price it', 'What the client needs to provide', 'Risks and how we handle them', 'How we measure success', 'Next steps and timeline'];
export const PUNCH: PunchCase[] = [
  { points: HOME, started: [0, 1], chunk: "So last spring I got the bill for my photo storage again, and it had gone up for the third time. I sat there thinking, I'm renting a hard drive from someone forever. That was kind of the moment. I had this dusty tower in the closet from my gaming days, an old i5, and I thought, what if that thing just held everything?" },
  { points: HOME, started: [1, 2], chunk: "Okay, so the case is open. Sixteen gigs of RAM, and the old graphics card comes out because it just eats power for nothing here. I'm putting in two four terabyte disks. Now the question everyone asks: do you copy one disk onto the other, or do you use one as parity? Let me explain how I think about it." },
  { points: HOME, started: [3], chunk: "Flash the USB stick, boot from it, pick the disk, and honestly that's it, the installer took less time than making coffee. Then you get a web page on your network where you set everything up. Before I put a single photo on it though, I want to tell you about the thing that saved me later." },
  { points: HOME, started: [4], chunk: "I keep three copies of anything I care about. Two at home on different devices, one somewhere else, in my case my brother's house. If the server dies, if the house floods, I still have it. People skip this because a server feels like a backup already, and it's not." },
  { points: HOME, started: [5, 6], chunk: "To reach it from my phone I use a mesh VPN, so nothing on my router is open to the internet. And people ask what it costs to run: I put a meter on the plug, it's about forty watts idle, so around five dollars a month where I live." },
  { points: MEALS, started: [0], chunk: "Sunday morning I go to the store with one list, and that list covers every lunch and dinner until Friday. If I don't do that, I end up at the store on Wednesday buying chips. So the list is built around three base things." },
  { points: MEALS, started: [1, 2], chunk: "First a big pot of rice, and while that's going I put quinoa in the other pot, enough for maybe ten servings. Then the oven: sweet potatoes on one tray, broccoli and peppers on the other, both at the same heat so they finish together." },
  { points: MEALS, started: [3, 6], chunk: "This is the part people skip and then wonder why it tastes like cardboard by Thursday. A jar of tahini lemon dressing, garlic, a bit of maple. It goes on the bowls, on the eggs, I've put it on toast. Also I switch the spices each week so it never feels like the same meal." },
  { points: MEALS, started: [4, 5], chunk: "Glass boxes, they stack, they go in the microwave. Cooked rice I keep three days in the fridge, four at most, after that it goes in the freezer in flat bags, which thaw in about ten minutes." },
  { points: MEALS, started: [7], chunk: "I did the math one month. Lunches out were running me around two hundred and forty dollars. This whole setup is maybe sixty in groceries. That's not counting the time, but honestly the time is an hour and a half on a Sunday." },
  { points: PIANO, started: [], chunk: "Hey everyone, welcome back. Quick thing before we start: thanks for all the comments on the last video, I read every one. Okay. Grab a coffee, this one's a bit longer than usual." },
  { points: PIANO, started: [0, 1], chunk: "Most people I talk to who started at forty gave up by week four. Not because they had no talent, but because they practiced twice for three hours, got sore and frustrated, and then never sat down again. Short and daily wins every time." },
  { points: PIANO, started: [2], chunk: "Do you need sheet music? I went back and forth on this. Playing what you hear is fun and fast, but the dots on the page let you open any book and just go. I did both, a little of the page every day plus songs from videos." },
  { points: PIANO, started: [3, 4], chunk: "My first real song was the theme from a game I loved as a kid. I was way more willing to grind on it than on some exercise. Left hand alone for a week, then the right hand alone, then slowly both at once." },
  { points: PIANO, started: [5, 6], chunk: "The click drove me nuts at first. What helped was setting it really slow, like sixty, and only speeding up when I could play it clean three times. Then I started filming myself on my phone and I was shocked at how uneven I actually was." },
  { points: PITCH, started: [0], chunk: "Right now your team spends about a day every week copying data from the field app into the billing system by hand, and twice last quarter an invoice went out wrong because of it. That's the thing we want to fix." },
  { points: PITCH, started: [], chunk: "Sorry, can everyone hear me okay? I think the screen share froze for a second. Okay, there it is. Let me just move this window out of the way." },
  { points: PITCH, started: [1, 2], chunk: "In the first five days we sit with two of your dispatchers, map every step, and build a small sync for one job type, so you see something working by Friday. We did exactly this for a plumbing company last year; their copying went from eight hours a week to under one." },
  { points: PITCH, started: [3, 4], chunk: "For that we need admin access to both systems, a test account, and about two hours from someone who knows the billing rules. The fee is fixed, one price for the first phase, not hourly, so there are no surprises." },
  { points: PITCH, started: [5, 6], chunk: "If the field app changes its export format, the sync breaks, so we put an alert on it that tells us before your invoices are hit. And we'll call it a success when the copying drops below one hour a week, which we check together after a month." },
];
