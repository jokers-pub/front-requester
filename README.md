# Joker Requester ![NPM Version](https://img.shields.io/npm/v/%40joker.front%2Frequester)

The `@joker.front/requester` library offers a wide range of configurable properties, which greatly assist developers in efficiently managing requests within their projects. It simplifies the process of handling various types of requests, such as HTTP requests, and provides flexibility in customizing the request behavior according to the specific requirements of the application.

### How to Use

To start using the `@joker.front/requester` in your project, follow these steps:

```ts
import { Requester } from "@joker.front/requester";

// Create a new instance of the Requester class. The constructor accepts an object with configuration options.
// In this example, we set the 'base' option to '/server'. This base URL will be prepended to all the relative paths specified in the subsequent requests. It allows you to define a common root for your API endpoints, making it easier to manage and update the API URLs in case of any changes.
// You can also configure other options here, such as headers, timeouts, authentication mechanisms, etc., depending on your application's needs.
let requester = new Requester({
    base: "/server"
    //... other configuration options can be added here
});

// Use the'requester' instance to send a request. The'request' method takes two parameters: the first is the relative URL path of the request (in this case, "/user/add"), and the second is an object containing the request data.
// Here, we are sending a request to add a user. The request data includes the username and password. The data object can be used to send various types of data, such as form data, JSON data, etc., depending on the API's requirements.
requester.request("/user/add", {
    data: {
        userName: "zohar",
        pwd: "1234"
    }
});
```

## Documentation

[Official Website](https://jokers.pub)

[Help Docs](https://front.jokers.pub/requester)

[Visual Coding IDE](https://viscode.jokers.pub)
