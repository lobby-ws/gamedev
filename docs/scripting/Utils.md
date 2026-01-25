# Utils

This document covers miscellaneous utility globals available in the scripting environment.

---

## `num`

A quick random helper built on `Math.random()`. Use `prng` when you need deterministic results across clients.

```javascript
/**
 * function num(min, max, dp=0) 
 */ 

// get a random integer between 0 and 10
const randomInt = num(0, 10);

// get a random float between 100 and 1000 with 2 decimal places
const randomFloat = num(100, 1000, 2);
```

---

## `prng`

Create a seeded random number generator so every client can see the same output.

```javascript
const rng = prng(42); // seed
const value = rng(0, 100, 2); // min, max, decimalPlaces
```

---

## `clamp`

Clamp a number between a minimum and maximum value.

```javascript
const clamped = clamp(value, 0, 1);
```

---

## `uuid`

Generate a short unique id (10 characters).

```javascript
const id = uuid();
```

---

## Three.js

Certain `three.js` classes and methods are exposed directly in the scripting API for your convenience.

- [`Vector3`](https://threejs.org/docs/#api/en/math/Vector3)
- [`Quaternion`](https://threejs.org/docs/#api/en/math/Quaternion)
- [`Euler`](https://threejs.org/docs/#api/en/math/Euler)
- [`Matrix4`](https://threejs.org/docs/#api/en/math/Matrix4)

---

## URL

The standard `URL` class is available for parsing and constructing URLs.

- [`URL`](https://developer.mozilla.org/en-US/docs/Web/API/URL)

---

## Fetch

Fetch is available as the `fetch` argument passed into your script entry (it is the same as `app.fetch`). It returns a restricted response object with `ok`, `status`, `json()`, `text()`, and similar helpers.

```javascript
export default async (world, app, fetch) => {
  const resp = await fetch('https://example.com/data.json');
  if (resp?.ok) {
    const data = await resp.json();
  }
}
```
