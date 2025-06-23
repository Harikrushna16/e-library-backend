import path from "node:path";
import fs from "node:fs";
import { Request, Response, NextFunction } from "express";
import cloudinary from "../config/cloudinary";
import createHttpError from "http-errors";
import bookModel from "./bookModel";
import { AuthRequest } from "../middlewares/authenticate";
import userModel from "../user/userModel";

const createBook = async (req: Request, res: Response, next: NextFunction) => {
    console.log("=== CREATE BOOK REQUEST ===");
    console.log("Body:", req.body);
    console.log("Files:", req.files);

    const { title, genre, description } = req.body;

    // Validate required fields
    if (!title || !genre || !description) {
        return next(
            createHttpError(400, "Title, genre, and description are required")
        );
    }

    const files = req.files as { [fieldname: string]: Express.Multer.File[] };

    // Check if files exist
    if (!files || !files.coverImage || !files.coverImage[0]) {
        return next(createHttpError(400, "Cover image is required"));
    }

    if (!files.file || !files.file[0]) {
        return next(createHttpError(400, "Book file is required"));
    }

    // Check file types
    const coverImageFile = files.coverImage[0];
    const bookFile = files.file[0];

    if (!coverImageFile.mimetype.startsWith("image/")) {
        return next(createHttpError(400, "Cover image must be an image file"));
    }

    if (bookFile.mimetype !== "application/pdf") {
        return next(createHttpError(400, "Book file must be a PDF"));
    }

    const coverImageMimeType = coverImageFile.mimetype.split("/").at(-1);
    const fileName = coverImageFile.filename;
    const filePath = path.resolve(
        __dirname,
        "../../public/data/uploads",
        fileName
    );

    const bookFileName = bookFile.filename;
    const bookFilePath = path.resolve(
        __dirname,
        "../../public/data/uploads",
        bookFileName
    );

    console.log("Cover image path:", filePath);
    console.log("Book file path:", bookFilePath);

    // Check if files exist on disk
    if (!fs.existsSync(filePath)) {
        return next(
            createHttpError(400, "Cover image file not found on server")
        );
    }

    if (!fs.existsSync(bookFilePath)) {
        return next(createHttpError(400, "Book file not found on server"));
    }

    try {
        console.log("Starting Cloudinary uploads...");

        // Upload cover image
        console.log("Uploading cover image...");
        const uploadResult = await cloudinary.uploader.upload(filePath, {
            filename_override: fileName,
            folder: "book-covers",
            format: coverImageMimeType,
        });
        console.log("Cover image uploaded:", uploadResult.secure_url);

        // Upload book file
        console.log("Uploading book file...");
        const bookFileUploadResult = await cloudinary.uploader.upload(
            bookFilePath,
            {
                resource_type: "raw",
                filename_override: bookFileName,
                folder: "book-pdfs",
                format: "pdf",
            }
        );
        console.log("Book file uploaded:", bookFileUploadResult.secure_url);

        const _req = req as AuthRequest;

        // Create book record
        console.log("Creating book record...");
        const newBook = await bookModel.create({
            title,
            description,
            genre,
            author: _req.userId,
            coverImage: uploadResult.secure_url,
            file: bookFileUploadResult.secure_url,
        });
        console.log("Book created:", newBook._id);

        // Clean up temp files
        try {
            await fs.promises.unlink(filePath);
            await fs.promises.unlink(bookFilePath);
            console.log("Temp files cleaned up successfully");
        } catch (unlinkError) {
            console.error("Error deleting temp files:", unlinkError);
            // Don't fail the request if temp file cleanup fails
        }

        res.status(201).json({ id: newBook._id });
    } catch (err: any) {
        console.error("=== CREATE BOOK ERROR ===");
        console.error("Error type:", err.constructor.name);
        console.error("Error message:", err.message);
        console.error("Error stack:", err.stack);

        // Clean up temp files on error
        try {
            if (fs.existsSync(filePath)) {
                await fs.promises.unlink(filePath);
            }
            if (fs.existsSync(bookFilePath)) {
                await fs.promises.unlink(bookFilePath);
            }
        } catch (cleanupError) {
            console.error(
                "Error cleaning up files after failure:",
                cleanupError
            );
        }

        // Provide more specific error messages
        if (err.message && err.message.includes("cloudinary")) {
            return next(
                createHttpError(500, "Error uploading files to cloud storage")
            );
        }

        if (err.name === "ValidationError") {
            return next(
                createHttpError(400, "Invalid book data: " + err.message)
            );
        }

        if (err.code === "ENOENT") {
            return next(createHttpError(400, "File not found on server"));
        }

        return next(
            createHttpError(
                500,
                "Error while uploading the files: " + err.message
            )
        );
    }
};

const updateBook = async (req: Request, res: Response, next: NextFunction) => {
    const { title, description, genre } = req.body;
    const bookId = req.params.bookId;

    try {
        const book = await bookModel.findOne({ _id: bookId });

        if (!book) {
            return next(createHttpError(404, "Book not found"));
        }

        // Check access
        const _req = req as AuthRequest;
        if (book.author.toString() !== _req.userId) {
            return next(
                createHttpError(403, "You can not update others book.")
            );
        }

        const files = req.files as {
            [fieldname: string]: Express.Multer.File[];
        };
        let completeCoverImage = "";

        // Handle cover image update
        if (files && files.coverImage && files.coverImage[0]) {
            const filename = files.coverImage[0].filename;
            const converMimeType = files.coverImage[0].mimetype
                .split("/")
                .at(-1);

            if (!files.coverImage[0].mimetype.startsWith("image/")) {
                return next(
                    createHttpError(400, "Cover image must be an image file")
                );
            }

            const filePath = path.resolve(
                __dirname,
                "../../public/data/uploads/" + filename
            );

            if (!fs.existsSync(filePath)) {
                return next(
                    createHttpError(400, "Cover image file not found on server")
                );
            }

            try {
                const uploadResult = await cloudinary.uploader.upload(
                    filePath,
                    {
                        filename_override: filename,
                        folder: "book-covers",
                        format: converMimeType,
                    }
                );

                completeCoverImage = uploadResult.secure_url;
                await fs.promises.unlink(filePath);
            } catch (uploadError) {
                console.error("Error uploading cover image:", uploadError);
                return next(
                    createHttpError(500, "Error uploading cover image")
                );
            }
        }

        // Handle book file update
        let completeFileName = "";
        if (files && files.file && files.file[0]) {
            const bookFileName = files.file[0].filename;

            if (files.file[0].mimetype !== "application/pdf") {
                return next(createHttpError(400, "Book file must be a PDF"));
            }

            const bookFilePath = path.resolve(
                __dirname,
                "../../public/data/uploads/" + bookFileName
            );

            if (!fs.existsSync(bookFilePath)) {
                return next(
                    createHttpError(400, "Book file not found on server")
                );
            }

            try {
                const uploadResultPdf = await cloudinary.uploader.upload(
                    bookFilePath,
                    {
                        resource_type: "raw",
                        filename_override: bookFileName,
                        folder: "book-pdfs",
                        format: "pdf",
                    }
                );

                completeFileName = uploadResultPdf.secure_url;
                await fs.promises.unlink(bookFilePath);
            } catch (uploadError) {
                console.error("Error uploading book file:", uploadError);
                return next(createHttpError(500, "Error uploading book file"));
            }
        }

        const updatedBook = await bookModel.findOneAndUpdate(
            { _id: bookId },
            {
                title: title,
                description: description,
                genre: genre,
                coverImage: completeCoverImage || book.coverImage,
                file: completeFileName || book.file,
            },
            { new: true }
        );

        res.json(updatedBook);
    } catch (err: any) {
        console.error("Update book error:", err);
        return next(
            createHttpError(
                500,
                "Error while updating the book: " + err.message
            )
        );
    }
};

const listBooks = async (req: Request, res: Response, next: NextFunction) => {
    try {
        // todo: add pagination.
        const books = await bookModel.find().populate("author", "name");
        res.json(books);
    } catch (err: any) {
        console.error("List books error:", err);
        return next(
            createHttpError(500, "Error while getting books: " + err.message)
        );
    }
};

const getSingleBook = async (
    req: Request,
    res: Response,
    next: NextFunction
) => {
    const bookId = req.params.bookId;

    try {
        const book = await bookModel
            .findOne({ _id: bookId })
            .populate("author", "name");

        if (!book) {
            return next(createHttpError(404, "Book not found."));
        }

        return res.json(book);
    } catch (err: any) {
        console.error("Get single book error:", err);
        return next(
            createHttpError(500, "Error while getting book: " + err.message)
        );
    }
};

const deleteBook = async (req: Request, res: Response, next: NextFunction) => {
    const bookId = req.params.bookId;

    try {
        const book = await bookModel.findOne({ _id: bookId });
        if (!book) {
            return next(createHttpError(404, "Book not found"));
        }

        // Check Access
        const _req = req as AuthRequest;
        if (book.author.toString() !== _req.userId) {
            return next(
                createHttpError(403, "You can not delete others book.")
            );
        }

        // Extract public IDs for Cloudinary deletion
        const coverFileSplits = book.coverImage.split("/");
        const coverImagePublicId =
            coverFileSplits.at(-2) +
            "/" +
            coverFileSplits.at(-1)?.split(".").at(-2);

        const bookFileSplits = book.file.split("/");
        const bookFilePublicId =
            bookFileSplits.at(-2) + "/" + bookFileSplits.at(-1);

        console.log("Deleting cover image:", coverImagePublicId);
        console.log("Deleting book file:", bookFilePublicId);

        // Delete files from Cloudinary
        try {
            await cloudinary.uploader.destroy(coverImagePublicId);
            await cloudinary.uploader.destroy(bookFilePublicId, {
                resource_type: "raw",
            });
        } catch (cloudinaryError) {
            console.error(
                "Error deleting files from Cloudinary:",
                cloudinaryError
            );
            // Continue with book deletion even if Cloudinary deletion fails
        }

        await bookModel.deleteOne({ _id: bookId });

        return res.sendStatus(204);
    } catch (err: any) {
        console.error("Delete book error:", err);
        return next(
            createHttpError(500, "Error while deleting book: " + err.message)
        );
    }
};

export { createBook, updateBook, listBooks, getSingleBook, deleteBook };
